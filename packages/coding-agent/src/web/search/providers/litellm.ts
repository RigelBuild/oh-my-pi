import { type ApiKey, type AuthStorage, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import { getDefaultModelDiscoveryBaseUrl } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import type { Setting } from "../../../config/registry";
import { isSettingsInitialized, settings } from "../../../config/settings";
import { cfgLitellmSearchTools } from "../../settings";
import type { SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { GOOGLE_QUERY_SYNTAX, formatQuery, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, normalizeSearchText, readLimitedText, siteHosts, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const LITELLM_QUERY_SYNTAX = { ...GOOGLE_QUERY_SYNTAX, site: false, dateRange: false };

interface LiteLLMSearchResponse {
	results?: unknown;
}

function errorMessage(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if ("error" in value) {
		const error = value.error;
		if (typeof error === "string") return normalizeSearchText(error);
		if (typeof error === "object" && error !== null && !Array.isArray(error) && "message" in error) {
			return normalizeSearchText(error.message);
		}
	}
	return "message" in value ? normalizeSearchText(value.message) : undefined;
}

function normalizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function searchTools(): string[] {
	const configured = findSetting(cfgLitellmSearchTools) ?? "";
	return [
		...new Set(
			configured
				.split(",")
				.map(tool => tool.trim())
				.filter(Boolean),
		),
	];
}

function findSetting(handle: Setting<string | undefined>): string | null {
	return (isSettingsInitialized() ? handle.get(settings) : handle.envValue()) ?? null;
}

function searchUrl(tool: string): string {
	const base = getDefaultModelDiscoveryBaseUrl("litellm") ?? "http://localhost:4000/v1";
	const normalizedBase = base.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	return `${normalizedBase}/v1/search/${encodeURIComponent(tool)}`;
}

function isRetryableToolFailure(error: unknown): boolean {
	if (!(error instanceof SearchProviderError)) return false;
	return (
		error.status === 404 ||
		error.status === 408 ||
		error.status === 429 ||
		(error.status !== undefined && error.status >= 500)
	);
}

async function callLiteLLMSearch(
	apiKey: string,
	params: SearchParams,
	tool: string,
	query: string,
	domains: string[],
	maxResults: number,
): Promise<{ response: LiteLLMSearchResponse; requestId?: string }> {
	const url = searchUrl(tool);
	const body: Record<string, unknown> = { query, max_results: maxResults };
	if (domains.length) body.search_domain_filter = domains;
	const requestSignal = withHardTimeout(params.signal, params.timeoutMs);
	let response: Response;
	try {
		response = await (params.fetch ?? fetch)(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		if (params.signal?.aborted) throw error;
		if (requestSignal.aborted) throw new SearchProviderError("litellm", "LiteLLM search timed out", 504);
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError("litellm", `LiteLLM network error: ${message}`, 503);
	}

	if (!response.ok) {
		const text = await readLimitedText(response, "litellm", MAX_ERROR_BYTES, true);
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = undefined;
		}
		// A proxy may echo the Authorization header back in its error body.
		const message = (errorMessage(payload) ?? (text.trim() || response.statusText)).replaceAll(apiKey, "[REDACTED]");
		const classified = classifyProviderHttpError("litellm", response.status, message);
		if (classified) throw classified;
		throw new SearchProviderError("litellm", `LiteLLM API error (${response.status}): ${message}`, response.status);
	}

	const raw = await readLimitedText(response, "litellm", MAX_RESPONSE_BYTES);
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new SearchProviderError("litellm", "LiteLLM API returned invalid JSON", 502);
	}
	const payload: LiteLLMSearchResponse =
		typeof data === "object" && data !== null && !Array.isArray(data) && "results" in data
			? { results: data.results }
			: {};
	return {
		response: payload,
		requestId: response.headers.get("x-litellm-call-id") ?? response.headers.get("x-request-id") ?? undefined,
	};
}

function toSearchResponse(
	response: LiteLLMSearchResponse,
	maxResults: number,
	requestId: string | undefined,
): SearchResponse {
	const sources: SearchSource[] = [];
	if (Array.isArray(response.results)) {
		for (const value of response.results) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const url = "url" in value ? normalizeUrl(value.url) : undefined;
			if (!url) continue;
			const publishedDate = "date" in value ? normalizeSearchText(value.date) : undefined;
			sources.push({
				title: ("title" in value ? normalizeSearchText(value.title) : undefined) ?? url,
				url,
				snippet: "snippet" in value ? normalizeSearchText(value.snippet) : undefined,
				publishedDate,
				ageSeconds: dateToAgeSeconds(publishedDate),
			});
		}
	}
	return {
		provider: "litellm",
		sources: sources.slice(0, maxResults),
		requestId,
		authMode: "api_key",
	};
}

/** Execute LiteLLM search, advancing tools only for tool-specific or transport failures. */
export async function searchLiteLLM(params: SearchParams): Promise<SearchResponse> {
	const tools = searchTools();
	if (tools.length === 0) {
		throw new SearchProviderError(
			"litellm",
			"LiteLLM search tools are not configured. Set litellm.searchTools or LITELLM_SEARCH_TOOLS.",
		);
	}
	const maxResults = Math.floor(
		clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
	);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives
		? formatQuery(
				{
					...parsed,
					raw: parsed.text,
					sites: [],
					excludedSites: [],
					after: undefined,
					before: undefined,
				},
				LITELLM_QUERY_SYNTAX,
			)
		: params.query;
	const domains = siteHosts(parsed.sites).slice(0, 20);
	const keyOrResolver: ApiKey = params.authStorage.keys.resolver("litellm", { sessionId: params.sessionId });
	const failures: string[] = [];

	for (const tool of tools) {
		try {
			const { response, requestId } = await withAuth(
				keyOrResolver,
				key => callLiteLLMSearch(key, params, tool, query, domains, maxResults),
				{
					signal: params.signal,
					missingKeyMessage:
						'LiteLLM credentials not found. Set LITELLM_API_KEY or configure an API key for provider "litellm".',
				},
			);
			params.signal?.throwIfAborted();
			return toSearchResponse(response, maxResults, requestId);
		} catch (error) {
			if (params.signal?.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${tool}: ${message}`);
			const status = error instanceof SearchProviderError ? error.status : undefined;
			if (status === 401 || status === 403 || !isRetryableToolFailure(error)) {
				throw new SearchProviderError("litellm", `LiteLLM search failed: ${failures.join("; ")}`, status);
			}
		}
	}

	throw new SearchProviderError("litellm", `All LiteLLM search tools failed: ${failures.join("; ")}`);
}

/** Search provider for LiteLLM's configured search tools. */
export class LiteLLMProvider extends SearchProvider {
	readonly id = "litellm";
	readonly label = "LiteLLM";

	isAvailable(authStorage: AuthStorage): boolean {
		return (
			(authStorage.keys.source("litellm") !== undefined || !!getEnvApiKey("litellm")) && searchTools().length > 0
		);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchLiteLLM(params);
	}
}
