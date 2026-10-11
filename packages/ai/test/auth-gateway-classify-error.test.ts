import { describe, expect, it } from "bun:test";
import { classifyGatewayError, classifyUpstreamFailure, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { UpstreamFailureKind } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

describe("auth-gateway classifyGatewayError", () => {
	it("honours an explicit numeric `status` property on the error", () => {
		const err = Object.assign(new Error("boom"), { status: 503 });
		const c = classifyGatewayError(err);
		expect(c.status).toBe(503);
		expect(c.type).toBe("upstream_error");
	});

	it("maps 401/403 to authentication_error via status property", () => {
		expect(classifyGatewayError(Object.assign(new Error(""), { status: 401 })).type).toBe("authentication_error");
		expect(classifyGatewayError(Object.assign(new Error(""), { status: 403 })).type).toBe("authentication_error");
	});

	it("maps 429 to rate_limit_error via status property", () => {
		expect(classifyGatewayError(Object.assign(new Error(""), { status: 429 })).type).toBe("rate_limit_error");
	});

	it("does NOT misclassify `GenerateContentRequest` 400 as rate-limited (the original bug)", () => {
		// Verbatim shape Google emits when functionResponse.name is missing.
		const msg =
			"Google API error (400): * GenerateContentRequest.contents[2].parts[0].function_response.name: Name cannot be empty.";
		const c = classifyGatewayError(new Error(msg));
		expect(c.status).toBe(400);
		expect(c.type).toBe("invalid_request_error");
	});

	it("extracts embedded status codes from common message shapes", () => {
		const cases: Array<[string, number, string]> = [
			["OpenAI API error (429): too many requests", 429, "rate_limit_error"],
			["HTTP 503: upstream gone away", 503, "upstream_error"],
			["status: 401 unauthorized", 401, "authentication_error"],
			["status_code=400 — bad json", 400, "invalid_request_error"],
			["Anthropic API error (529): overloaded", 529, "upstream_error"],
		];
		for (const [msg, status, type] of cases) {
			const c = classifyGatewayError(new Error(msg));
			expect({ msg, status: c.status, type: c.type }).toEqual({ msg, status, type });
		}
	});

	it("ignores incidental three-digit numbers without a status keyword", () => {
		// "took 200ms" should not get classified as 2xx and short-circuit.
		const c = classifyGatewayError(new Error("upstream took 200ms then timed out"));
		// Falls through all heuristics → default upstream_error/502.
		expect(c.status).toBe(502);
	});

	it("still recognizes rate-limit wording when no status is embedded", () => {
		const c = classifyGatewayError(new Error("too many requests — back off"));
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("prefers rate-limit wording over auth wording", () => {
		const c = classifyGatewayError(new Error("Rate limit exceeded - unauthorized due to throttling"));
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("classifies Codex 'You have hit your ChatGPT usage limit' as 429", () => {
		// Verbatim shape Codex returns from the `usage_limit_reached` branch
		// in `parseCodexError`. No embedded `HTTP NNN`/`(NNN)`/`status NNN`
		// token, no `rate limit`/`too many requests` wording — only the
		// gateway's `isUsageLimitError` branch catches this. Previously it
		// fell through to the default 502/upstream_error, which is why the
		// `lg` retry loop kept looping instead of switching to another
		// credential.
		const c = classifyGatewayError(
			new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
		);
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("classifies generic 'usage_limit_reached' code text as 429", () => {
		const c = classifyGatewayError(new Error('{"code":"usage_limit_reached","message":"…"}'));
		expect(c.status).toBe(429);
		expect(c.type).toBe("rate_limit_error");
	});

	it("does not match 'rate' inside camelCase or compound words", () => {
		// `Generate`, `iterate`, `deprecated`, `accelerate` all contain `rate` as
		// a substring and used to trip the classifier.
		for (const msg of [
			"GenerateContentRequest validation failed",
			"iterate over the candidate list",
			"deprecated field on response",
			"AccelerateProvider not registered",
		]) {
			const c = classifyGatewayError(new Error(msg));
			expect({ msg, status: c.status }).not.toEqual({ msg, status: 429 });
		}
	});

	it("classifies AbortError instances as 499 request_aborted", () => {
		const err = new Error("client gave up");
		err.name = "AbortError";
		const c = classifyGatewayError(err);
		expect(c.status).toBe(499);
		expect(c.type).toBe("request_aborted");
	});

	it("classifies word-boundaried 'aborted' wording as 499", () => {
		const c = classifyGatewayError(new Error("request aborted by caller"));
		expect(c.status).toBe(499);
		expect(c.type).toBe("request_aborted");
	});

	it("falls through to 502 upstream_error when nothing matches", () => {
		const c = classifyGatewayError(new Error("something inscrutable happened"));
		expect(c.status).toBe(502);
		expect(c.type).toBe("upstream_error");
	});
});

const classifierModel = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://models.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} satisfies ModelSpec<"anthropic-messages">);

describe("auth-gateway classifyUpstreamFailure", () => {
	const cases: Array<{
		name: string;
		error: unknown;
		status?: number;
		message?: string;
		kind?: UpstreamFailureKind;
		expectedStatus?: number;
		expectedMessage?: string;
	}> = [
		{ name: "usage limit", error: new Error("usage_limit_reached"), status: 429, kind: "credential_exhausted" },
		{
			name: "thrown 429 retains structured usage-limit cause",
			error: new ProviderHttpError("Generic provider failure", 429, {
				cause: new ProviderHttpError("Generic provider failure", 429, { code: "usage_limit_reached" }),
			}),
			status: 429,
			kind: "credential_exhausted",
		},
		{ name: "opaque 429", error: new Error(""), status: 429, kind: "credential_exhausted" },
		{ name: "401", error: new Error("Unauthorized"), status: 401, kind: "credential_exhausted" },
		{
			name: "403 cap takes precedence over credential usage-limit wording",
			error: new Error("concurrent requests limit exceeded; usage_limit_reached"),
			status: 403,
			kind: "rate_limited",
		},
		{ name: "credential 403", error: new Error("Forbidden"), status: 403, kind: "credential_exhausted" },
		{
			name: "403 concurrency cap",
			error: new Error("concurrent requests limit exceeded"),
			status: 403,
			kind: "rate_limited",
		},
		{ name: "429 rate limit", error: new Error("Too many requests"), status: 429, kind: "rate_limited" },
		{ name: "404", error: new Error("Not found"), status: 404, kind: "not_served" },
		{ name: "408", error: new Error("Request timeout"), status: 408, kind: "server_error" },
		{ name: "503", error: new Error("Unavailable"), status: 503, kind: "server_error" },
		{ name: "400 stops", error: new Error("Bad request"), status: 400 },
		{ name: "400 transport wording stops", error: new Error("fetch failed"), status: 400 },
		{
			name: "401 takes precedence over concurrency-cap wording",
			error: new Error("concurrent requests limit exceeded"),
			status: 401,
			kind: "credential_exhausted",
		},
		{
			name: "Anthropic rate limit without status",
			error: new Error("Anthropic stream error (rate_limit_error): Rate limit exceeded"),
			kind: "rate_limited",
		},
		{
			name: "Anthropic overload without status",
			error: new Error("Anthropic stream error (overloaded_error): Overloaded"),
			kind: "server_error",
		},
		{ name: "transport failure without status", error: new Error("fetch failed"), kind: "transport" },
		{
			name: "statusless concurrency cap",
			error: new Error("Too many requests; concurrent requests limit exceeded"),
			kind: "rate_limited",
		},
		{ name: "statusless server failure", error: new Error("internal server error"), kind: "server_error" },
		{ name: "statusless usage limit", error: new Error("usage_limit_reached"), kind: "credential_exhausted" },
		{
			name: "incidental 500 in invalid request stops",
			error: new Error("invalid_request_error: prompt is too long: 205000 tokens"),
		},
		{
			name: "classification message takes precedence",
			error: new Error("socket closed unexpectedly"),
			message: "Too many requests",
			kind: "rate_limited",
			expectedStatus: undefined,
			expectedMessage: "Too many requests",
		},
		{
			name: "retryability follows selected classification message over thrown message",
			error: new Error("fetch failed"),
			message: "invalid_request_error: prompt is too long: 205000 tokens",
		},
		{
			name: "assistant-message status and message are wrapped for classification",
			error: undefined,
			message: "Unauthorized",
			status: 401,
			kind: "credential_exhausted",
			expectedStatus: 401,
			expectedMessage: "Unauthorized",
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			const result = classifyUpstreamFailure(classifierModel, testCase.error, testCase.status, testCase.message);
			if (testCase.kind === undefined) {
				expect(result).toBeUndefined();
				return;
			}
			expect(result?.kind).toBe(testCase.kind);
			expect(result?.status).toBe(testCase.expectedStatus ?? testCase.status);
			expect(result?.message).toBe(
				testCase.expectedMessage ??
					testCase.message ??
					(testCase.error instanceof Error ? testCase.error.message : ""),
			);
		});
	}

	it("reads retry-after from a thrown error's headers", () => {
		const error = Object.assign(new Error("upstream unavailable"), {
			status: 503,
			headers: new Headers({ "retry-after": "60" }),
		});
		expect(classifyUpstreamFailure(classifierModel, error, undefined, undefined)?.retryAfterMs).toBe(60_000);
	});
	it("does not use text retry hints for a thrown error without headers", () => {
		const error = Object.assign(new Error("upstream unavailable; retry-after-ms=12000"), { status: 503 });
		expect(classifyUpstreamFailure(classifierModel, error, undefined, undefined)?.retryAfterMs).toBeUndefined();
	});

	it("reads retry timing from an AssistantMessage-derived text hint", () => {
		const result = classifyUpstreamFailure(
			classifierModel,
			undefined,
			503,
			"upstream unavailable; retry-after-ms=12000",
		);
		expect(result?.retryAfterMs).toBe(12_000);
	});
});
