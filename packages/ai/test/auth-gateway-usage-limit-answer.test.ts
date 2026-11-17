/**
 * RIG-10540: `gatewayUsageLimitAnswer` answers 429 only for a usage window that
 * reopens on a clock. A billing cap (a 402 out-of-credit balance, Anthropic's
 * "credit balance is too low" 400) keeps its own status, so the gate returns
 * `undefined` for it and the caller's classifier answers the real status.
 */
import { describe, expect, it } from "bun:test";
import { gatewayUsageLimitAnswer } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";

const OUT_OF_CREDIT_BODY = "the organization is out of credit, add more to continue (type=insufficient_quota)";
const ANTHROPIC_CREDIT_BODY =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

describe("gatewayUsageLimitAnswer: billing caps keep their status (RIG-10540)", () => {
	it("returns undefined for a 402 out-of-credit error", () => {
		const error = new ProviderHttpError(OUT_OF_CREDIT_BODY, 402);

		expect(gatewayUsageLimitAnswer("openai-codex", error)).toBeUndefined();
	});

	it("returns undefined for Anthropic's credit-balance 400", () => {
		const error = new ProviderHttpError(ANTHROPIC_CREDIT_BODY, 400);

		expect(gatewayUsageLimitAnswer("anthropic", error)).toBeUndefined();
	});

	it("still answers a plain 429 usage limit with a 429", () => {
		const error = new ProviderHttpError("usage_limit_reached retry-after-ms=60000", 429);
		const answer = gatewayUsageLimitAnswer("openai-codex", error);

		expect(answer?.failure.status).toBe(429);
		expect(answer?.retryAfterMs).toBe(60_000);
	});
});
