import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { LiteLLMProvider, searchLiteLLM } from "@oh-my-pi/pi-coding-agent/web/search/providers/litellm";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const originalEnv = {
	apiKey: process.env.LITELLM_API_KEY,
	baseUrl: process.env.LITELLM_BASE_URL,
	searchTools: process.env.LITELLM_SEARCH_TOOLS,
};
const catalogAuthStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(catalogAuthStorage);
const model = modelRegistry.find("web", "litellm");
if (!model) throw new Error("Expected bundled web/litellm model");

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	process.env.LITELLM_BASE_URL = "http://localhost:4000/v1";
});
afterAll(() => {
	catalogAuthStorage.close();
});

afterEach(() => {
	restoreEnv("LITELLM_API_KEY", originalEnv.apiKey);
	restoreEnv("LITELLM_BASE_URL", originalEnv.baseUrl);
	restoreEnv("LITELLM_SEARCH_TOOLS", originalEnv.searchTools);
});

const authStorage = {
	keys: {
		get: async () => process.env.LITELLM_API_KEY ?? undefined,
		resolver: () => async () => process.env.LITELLM_API_KEY ?? undefined,
		source: () => (process.env.LITELLM_API_KEY ? { kind: "env", concrete: true } : undefined),
	},
} as unknown as AuthStorage;

function makeParams(query: string, extras: Partial<SearchParams> = {}): SearchParams {
	return {
		query,
		authStorage,
		systemPrompt: "LiteLLM search test",
		model: model!,
		modelRegistry,
		...extras,
	};
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
	if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
	const parsed: unknown = JSON.parse(init.body);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Expected object request body");
	}
	return parsed as Record<string, unknown>;
}

describe("LiteLLM search", () => {
	it.each([
		["http://localhost:4000/v1", "http://localhost:4000/v1/search/web-search"],
		["http://localhost:4000/v1/", "http://localhost:4000/v1/search/web-search"],
		["http://localhost:4000/", "http://localhost:4000/v1/search/web-search"],
	])("normalizes the base URL %s and sends domain filters and a clamped count", async (baseUrl, expectedUrl) => {
		process.env.LITELLM_API_KEY = "test-key";
		process.env.LITELLM_SEARCH_TOOLS = " web-search ";
		process.env.LITELLM_BASE_URL = baseUrl;
		const calledUrls: string[] = [];
		let body: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			calledUrls.push(requestUrl(input));
			body = jsonBody(init);
			return Response.json({ object: "search", results: [] });
		};

		await searchLiteLLM(
			makeParams(
				`cats ${Array.from({ length: 21 }, (_, index) => `site:example${index}.com`).join(" ")} intitle:guide after:2025-01-01`,
				{ limit: 99, fetch: fetchMock },
			),
		);

		expect(calledUrls).toEqual([expectedUrl]);
		expect(body?.query).toBe("cats intitle:guide");
		expect(body?.max_results).toBe(20);
		expect(body?.search_domain_filter).toEqual(Array.from({ length: 20 }, (_, index) => `example${index}.com`));
	});

	it("maps valid HTTP results and drops non-HTTP URLs", async () => {
		process.env.LITELLM_API_KEY = "test-key";
		process.env.LITELLM_SEARCH_TOOLS = "web-search";
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "search",
					results: [
						{
							title: "  A   result ",
							url: "https://example.com/a",
							snippet: "  short   text ",
							date: "2026-01-02",
						},
						{ title: "Unsafe", url: "javascript:alert(1)", snippet: "discard" },
						{ url: "http://example.net/" },
					],
				}),
				{ headers: { "x-litellm-call-id": "call-123", "x-request-id": "request-456" } },
			);

		const result = await searchLiteLLM(makeParams("cats", { fetch: fetchMock }));

		expect(result.provider).toBe("litellm");
		expect(result.authMode).toBe("api_key");
		expect(result.requestId).toBe("call-123");
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0]).toMatchObject({
			title: "A result",
			url: "https://example.com/a",
			snippet: "short text",
			publishedDate: "2026-01-02",
		});
		expect(result.sources[1]).toMatchObject({ title: "http://example.net/", url: "http://example.net/" });
	});

	it("tries the next configured tool when a tool is missing", async () => {
		process.env.LITELLM_API_KEY = "test-key";
		process.env.LITELLM_SEARCH_TOOLS = "missing, available";
		const calledUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = requestUrl(input);
			calledUrls.push(url);
			if (url.endsWith("/search/missing")) {
				return new Response(
					JSON.stringify({ error: { message: "Search tool 'missing' not found in router.search_tools" } }),
					{
						status: 500,
					},
				);
			}
			return Response.json({ object: "search", results: [{ url: "https://example.com", title: "Found" }] });
		};

		const result = await searchLiteLLM(makeParams("cats", { fetch: fetchMock }));

		expect(calledUrls).toEqual([
			"http://localhost:4000/v1/search/missing",
			"http://localhost:4000/v1/search/available",
		]);
		expect(result.sources[0]?.title).toBe("Found");
	});

	it("surfaces authorization failures without trying another tool", async () => {
		process.env.LITELLM_API_KEY = "test-key";
		process.env.LITELLM_SEARCH_TOOLS = "first, second";
		const calledUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			calledUrls.push(requestUrl(input));
			return new Response(JSON.stringify({ error: { message: "invalid API key" } }), { status: 401 });
		};

		const search = searchLiteLLM(makeParams("cats", { fetch: fetchMock }));

		await expect(search).rejects.toMatchObject({ provider: "litellm", status: 401 });
		await expect(search).rejects.toThrow("401 unauthorized");
		expect(calledUrls).toEqual(["http://localhost:4000/v1/search/first"]);
	});

	it("is available only when a credential and at least one search tool are configured", () => {
		const provider = new LiteLLMProvider();
		process.env.LITELLM_API_KEY = "test-key";
		delete process.env.LITELLM_SEARCH_TOOLS;
		expect(provider.isAvailable(authStorage)).toBe(false);

		process.env.LITELLM_SEARCH_TOOLS = " first, , second, first ";
		delete process.env.LITELLM_API_KEY;
		expect(provider.isAvailable(authStorage)).toBe(false);

		process.env.LITELLM_API_KEY = "test-key";
		expect(provider.isAvailable(authStorage)).toBe(true);
	});
});
