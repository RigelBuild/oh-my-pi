/**
 * Shared HTTP helpers for the auth-gateway routes.
 *
 * Centralized so we share the same JSON shape, auth check,
 * and peer-resolution logic.
 */
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import * as os from "node:os";
import { getInstallId } from "@oh-my-pi/pi-utils";
import type { Api, Model } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import type { ClientUsageIdentity } from "../usage";
import type { AgentCaller, AuthGatewayAuthorizer, CallerIdentity, EnrollCaller } from "./types";

const JSON_HEADERS = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
} as const;

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body) ?? "null", {
		status,
		headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS,
	});
}

/**
 * Diagnostic response headers for translated inference requests, mirroring the
 * names existing gateway-aware clients already parse: `x-request-id` /
 * `request-id` (surfaced as `_request_id` by the OpenAI and Anthropic SDKs,
 * matches the gateway log line), LiteLLM's model-resolution and cost headers,
 * and OpenAI's `openai-processing-ms`. Model/request-id headers are always
 * present; `costUsd` — known only once a non-streaming response has settled —
 * adds the computed cost, and `startedAt` the wall time. Streaming responses
 * send headers before usage exists, so they carry only the identity headers.
 */
export function gatewayResponseHeaders(
	model: Model<Api>,
	info: { requestId: string; costUsd?: number; startedAt?: number },
): Record<string, string> {
	const headers: Record<string, string> = {
		"x-request-id": info.requestId,
		"request-id": info.requestId,
		"x-litellm-model-id": model.id,
	};
	if (model.baseUrl) headers["x-litellm-model-api-base"] = model.baseUrl;
	if (info.costUsd !== undefined) headers["x-litellm-response-cost"] = info.costUsd.toString();
	if (info.startedAt !== undefined) {
		const elapsed = (performance.now() - info.startedAt).toFixed(0);
		headers["x-litellm-response-duration-ms"] = elapsed;
		headers["openai-processing-ms"] = elapsed;
	}
	return headers;
}

/** Use the socket peer unless the gateway explicitly trusts its reverse proxy. */
export function resolvePeer(req: Request, socketAddress: string, trustProxyHeaders = false): string {
	if (!trustProxyHeaders) return socketAddress;
	const fwd = req.headers.get("x-forwarded-for");
	if (fwd) return fwd.split(",")[0].trim();
	return req.headers.get("x-real-ip") ?? socketAddress;
}

/**
 * Decode each run of percent-escapes on its own, so one malformed escape
 * elsewhere in the URL cannot hide an encoded token. A run that is not valid
 * UTF-8 still has its ASCII escapes decoded.
 */
function decodeUrlLeniently(location: string): string {
	return location.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
		try {
			return decodeURIComponent(run);
		} catch {
			return run.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
		}
	});
}

/** Keep the admitting bearer out of URL and forwarded/logged request fields. */
export function hasMisplacedBearer(req: Request, url: URL, token: string): boolean {
	const location = url.pathname + url.search;
	if (location.includes(token) || decodeUrlLeniently(location).includes(token)) return true;
	for (const [name, value] of req.headers) {
		if (
			(PASSTHROUGH_HEADER_NAMES[name] ||
				name.startsWith("x-stainless-") ||
				name.startsWith("x-omp-") ||
				name === "x-forwarded-for" ||
				name === "x-real-ip" ||
				name === "forwarded") &&
			value.includes(token)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Constant-time byte comparison. Falls back to a manual XOR accumulator if
 * `node:crypto.timingSafeEqual` isn't available. Always processes every byte
 * of the longer input so length itself doesn't leak via timing.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length === b.length && typeof nodeTimingSafeEqual === "function") {
		return nodeTimingSafeEqual(a, b);
	}
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		// Out-of-range reads return undefined → coerce to 0 via `| 0`.
		const av = (i < a.length ? a[i] : 0) | 0;
		const bv = (i < b.length ? b[i] : 0) | 0;
		diff |= av ^ bv;
	}
	return diff === 0;
}

const TOKEN_ENCODER = new TextEncoder();

/** The bearer token from `Authorization`, or `undefined` when none (or a blank one) is presented. */
export function presentedBearer(req: Request): string | undefined {
	const token = req.headers
		.get("authorization")
		?.match(/^Bearer\s+(.+)$/i)?.[1]
		.trim();
	return token ? token : undefined;
}

/**
 * The one caller every request is admitted as under shared bearer tokens. The
 * NUL in its id keeps any real account from colliding with it.
 */
export const SHARED_TOKEN_CALLER: AgentCaller = Object.freeze({ kind: "agent", agentAccountId: "\u0000shared" });

/**
 * The caller an empty token set admits. The server matches it by reference: its
 * bearer, if any, was never checked, so there is no credential to keep out of the URL.
 */
export const UNAUTHENTICATED_CALLER: AgentCaller = Object.freeze({ kind: "agent", agentAccountId: "\u0000shared" });

/** The one enrollment caller; {@link withEnrollToken} admits the server's enroll token as it. */
export const ENROLL_CALLER: EnrollCaller = Object.freeze({ kind: "enroll" });

/** A non-empty id with no NUL: the reserved shared id carries one, so no real id can collide with it. */
function isAccountId(value: unknown): value is string {
	return typeof value === "string" && value !== "" && !value.includes("\u0000");
}

/**
 * Whether an authorizer result names a caller. Anything else (`undefined`, `{}`, an
 * unknown kind, an empty or NUL-bearing id or owner) is answered 401, never mapped to a default caller.
 */
export function isCallerIdentity(value: unknown): value is CallerIdentity {
	if (value === SHARED_TOKEN_CALLER || value === UNAUTHENTICATED_CALLER || value === ENROLL_CALLER) return true;
	if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "agent") return false;
	if (!("agentAccountId" in value) || !isAccountId(value.agentAccountId)) return false;
	return !("ownerUserId" in value) || value.ownerUserId === undefined || isAccountId(value.ownerUserId);
}

/**
 * The session id providers key their process-wide caches by. Per-account callers
 * get their own namespace, so two agents sending the same key never share one;
 * the shared caller keeps the key verbatim so existing caches stay warm.
 */
export function callerSessionId(caller: AgentCaller, sessionId: string): string {
	if (caller.agentAccountId === SHARED_TOKEN_CALLER.agentAccountId) return sessionId;
	return deterministicUuid(`${caller.agentAccountId}\u0000${sessionId}`);
}

/**
 * Admits the server's enroll token as {@link ENROLL_CALLER} and hands every other
 * request to `authorize`. The compare is timing-safe, including across lengths.
 */
export function withEnrollToken(enrollToken: string, authorize: AuthGatewayAuthorizer): AuthGatewayAuthorizer {
	// A presented bearer is trimmed, so a padded token could never match: refuse it here, not as a silent 401.
	if (!enrollToken || enrollToken.trim() !== enrollToken) {
		throw new Error("enroll token must be non-empty with no surrounding whitespace");
	}
	const expected = TOKEN_ENCODER.encode(enrollToken);
	return req => {
		const bearer = presentedBearer(req);
		if (bearer !== undefined && timingSafeEqual(TOKEN_ENCODER.encode(bearer), expected)) return ENROLL_CALLER;
		return authorize(req);
	};
}

/**
 * Authorizer for a static shared-token set: any listed token admits the request
 * as {@link SHARED_TOKEN_CALLER}. An empty set admits every request as {@link UNAUTHENTICATED_CALLER}.
 */
export function bearerTokenAuthorizer(tokens: Iterable<string>): AuthGatewayAuthorizer {
	const allowed = [...new Set(tokens)].map(token => TOKEN_ENCODER.encode(token));
	return req => {
		if (allowed.length === 0) return UNAUTHENTICATED_CALLER;
		const bearer = presentedBearer(req);
		if (bearer === undefined) return null;
		const presented = TOKEN_ENCODER.encode(bearer);
		// Compare against every token so timing doesn't reveal which one matched.
		let ok = false;
		for (const expected of allowed) {
			if (timingSafeEqual(presented, expected)) ok = true;
		}
		return ok ? SHARED_TOKEN_CALLER : null;
	};
}

/**
 * Allow-list of inbound request headers that the gateway captures and forwards
 * to the underlying parsers (which decide whether to surface them to the
 * provider). Case-insensitive; `x-stainless-` is a prefix match.
 */
const PASSTHROUGH_HEADER_NAMES: Record<string, true> = {
	"anthropic-beta": true,
	"anthropic-version": true,
	"anthropic-user-profile-id": true,
	"openai-organization": true,
	"openai-project": true,
	"openai-beta": true,
	// Codex / ChatGPT-OAuth backend headers (see @oh-my-pi/pi-catalog/wire/codex).
	// `session_id` and `conversation_id` thread the upstream session so prompt
	// caching and per-conversation rate limiting work; `chatgpt-account-id` and
	// `originator` identify the calling account and client surface.
	"chatgpt-account-id": true,
	originator: true,
	session_id: true,
	conversation_id: true,
	// Vendor-neutral cache-identity headers. The gateway also reads these to
	// populate `options.promptCacheKey` (see `resolvePromptCacheKey` below)
	// so explicit client hints win over the derived fallback.
	"x-prompt-cache-key": true,
	"x-session-id": true,
	"x-conversation-id": true,
};

/**
 * Extract allow-listed passthrough headers from an inbound request. Keys are
 * lowercased; empty values are dropped. Called once per request in
 * `handleFormatEndpoint`; parsers then read `options.headers`.
 */
export function captureRequestHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (!value) return;
		const lower = key.toLowerCase();
		if (PASSTHROUGH_HEADER_NAMES[lower] || lower.startsWith("x-stainless-")) {
			out[lower] = value;
		}
	});
	return out;
}

/**
 * Resolve the usage-attribution identity for an inbound gateway request.
 *
 * pi-native omp clients send `x-omp-install-id` / `x-omp-hostname` /
 * `x-omp-app` (see `providers/pi-native-client.ts`); any client may set them.
 * Requests without an install id fall back to the gateway host's identity
 * under the `gateway` app label, so unlabeled foreign-SDK traffic (llm-git,
 * openai/anthropic SDKs) still lands in per-client burn tracking instead of
 * vanishing. These headers are attribution-only — they are deliberately
 * absent from {@link captureRequestHeaders}'s allow-list and never reach the
 * upstream provider.
 */
export function resolveClientIdentity(headers: Headers): ClientUsageIdentity {
	const read = (name: string): string | undefined => {
		const value = headers.get(name)?.trim();
		return value ? value : undefined;
	};
	const installId = read("x-omp-install-id");
	const app = read("x-omp-app");
	if (!installId) {
		return { installId: getInstallId(), hostname: os.hostname(), app: app ?? "gateway" };
	}
	return { installId, hostname: read("x-omp-hostname"), app: app ?? "gateway" };
}

/**
 * Priority order for resolving a client-supplied prompt-cache identity. The
 * first non-empty value wins. When none are present, the gateway derives a
 * stable UUID from the request's stable parts.
 */
const CACHE_KEY_HEADERS: readonly string[] = [
	"x-prompt-cache-key",
	"session_id",
	"conversation_id",
	"x-session-id",
	"x-conversation-id",
];

function readBodyCacheKey(body: unknown): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const root = body as Record<string, unknown>;
	// Explicit body fields (OpenAI Responses / Chat).
	const direct = root.prompt_cache_key;
	if (typeof direct === "string" && direct.length > 0) return direct;
	// Nested `metadata` (Codex CLI / Anthropic clients that route a session
	// identifier through the metadata bag).
	const metadata = root.metadata;
	if (metadata === null || typeof metadata !== "object") return undefined;
	const meta = metadata as Record<string, unknown>;
	for (const field of ["prompt_cache_key", "session_id", "conversation_id"] as const) {
		const v = meta[field];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

/**
 * Resolve a prompt-cache identity from inbound request body + headers.
 * Order of precedence (first wins):
 *   1. Body `prompt_cache_key`
 *   2. Body `metadata.{prompt_cache_key,session_id,conversation_id}`
 *   3. Header `x-prompt-cache-key`
 *   4. Header `session_id` / `conversation_id` (Codex / ChatGPT-OAuth surface)
 *   5. Header `x-session-id` / `x-conversation-id` (common informal)
 * Returns undefined when none present; the gateway then derives a stable
 * UUID from the request's stable parts.
 */
export function resolvePromptCacheKey(body: unknown, headers?: Headers): string | undefined {
	const fromBody = readBodyCacheKey(body);
	if (fromBody) return fromBody;
	if (!headers) return undefined;
	for (const name of CACHE_KEY_HEADERS) {
		const v = headers.get(name);
		if (v && v.length > 0) return v;
	}
	return undefined;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":
		"authorization, content-type, anthropic-version, anthropic-beta, anthropic-user-profile-id, openai-organization, openai-project, x-stainless-*, x-api-key",
	"Access-Control-Expose-Headers":
		"x-request-id, request-id, x-litellm-model-id, x-litellm-model-api-base, x-litellm-response-cost, x-litellm-response-duration-ms, openai-processing-ms",
	"Access-Control-Max-Age": "86400",
};

/**
 * CORS headers for the auth-gateway. Currently echoes a wildcard origin; the
 * request is accepted so future tightening can mirror `Origin` without
 * threading the request through every caller.
 */
export function corsHeaders(_req: Request): Record<string, string> {
	return { ...CORS_HEADERS };
}

/**
 * Re-emit `response` with CORS headers merged. The original response body is
 * passed through unchanged. Used by the gateway wrapper so every outbound
 * format-endpoint response carries the same CORS surface as the preflight.
 */
export function withCors(response: Response, req: Request): Response {
	const headers = new Headers(response.headers);
	const cors = corsHeaders(req);
	for (const k in cors) headers.set(k, cors[k]);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
