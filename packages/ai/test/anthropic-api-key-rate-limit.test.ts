import { describe, expect, it } from "bun:test";
import { observedLimitErrorStatus } from "@oh-my-pi/pi-ai/error/rate-limit";
import { parseAnthropicApiKeyRateLimitHeaders } from "@oh-my-pi/pi-ai/usage/anthropic-api";

describe("Anthropic Console API-key rate-limit headers", () => {
	it("parses requests and both token windows into the configured row", () => {
		const limits = parseAnthropicApiKeyRateLimitHeaders(
			{
				"anthropic-ratelimit-requests-limit": "100",
				"anthropic-ratelimit-requests-remaining": "40",
				"anthropic-ratelimit-input-tokens-limit": "1000",
				"anthropic-ratelimit-input-tokens-remaining": "500",
				"anthropic-ratelimit-output-tokens-limit": "800",
				"anthropic-ratelimit-output-tokens-remaining": "200",
			},
			"opus-5.5",
		);

		expect(limits.map(limit => limit.id)).toEqual([
			"anthropic:api:opus-5.5:requests",
			"anthropic:api:opus-5.5:input-tokens",
			"anthropic:api:opus-5.5:output-tokens",
		]);
		expect(limits.map(limit => limit.amount.used)).toEqual([60, 500, 600]);
	});

	it("preserves available fields when other headers are missing or malformed", () => {
		const limits = parseAnthropicApiKeyRateLimitHeaders(
			{
				"anthropic-ratelimit-requests-limit": "not-a-number",
				"anthropic-ratelimit-requests-remaining": "5",
				"anthropic-ratelimit-input-tokens-reset": "not-a-date",
				"anthropic-ratelimit-output-tokens-reset": "1780405800",
			},
			"opus-4.x",
		);

		expect(limits).toHaveLength(2);
		expect(limits[0]?.amount.remaining).toBe(5);
		expect(limits[0]?.status).toBe("unknown");
		expect(limits[1]?.window?.resetsAt).toBe(1_780_405_800_000);
	});

	it("does not observe an unmapped model", () => {
		expect(parseAnthropicApiKeyRateLimitHeaders({ "anthropic-ratelimit-requests-limit": "1" }, undefined)).toEqual(
			[],
		);
	});
});

describe("observed credential error status", () => {
	it("records rate_limited only for a real throttle", () => {
		expect(observedLimitErrorStatus(429, "Too many requests, please slow down")).toBe("rate_limited");
		expect(
			observedLimitErrorStatus(
				undefined,
				'{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
			),
		).toBe("rate_limited");
	});

	it("records credit_exhausted for recognized credit depletion", () => {
		expect(observedLimitErrorStatus(400, "Your credit balance is too low to access the Anthropic API.")).toBe(
			"credit_exhausted",
		);
		expect(observedLimitErrorStatus(402, "Insufficient credits for this request")).toBe("credit_exhausted");
		expect(observedLimitErrorStatus(429, "Your prepaid balance is used up: Add funds")).toBe("credit_exhausted");
	});

	it("records no status for other quota and billing classes", () => {
		expect(observedLimitErrorStatus(400, "You have reached your monthly spend limit")).toBeUndefined();
		expect(observedLimitErrorStatus(429, "You have reached your monthly spend limit")).toBeUndefined();
		expect(observedLimitErrorStatus(429, "Your subscription plan quota is exhausted")).toBeUndefined();
		expect(observedLimitErrorStatus(403, "Usage credits are required for this model")).toBeUndefined();
		expect(observedLimitErrorStatus(402, "Payment required")).toBeUndefined();
	});
});
