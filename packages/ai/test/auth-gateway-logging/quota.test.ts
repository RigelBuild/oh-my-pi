import { expect, test } from "bun:test";
import {
	gatewayLogContext,
	logGatewayAttemptFailure,
	logGatewayProviderResponse,
} from "@oh-my-pi/pi-ai/auth-gateway/logging";
import { captureLogs, secret } from "./capture";

test("projects observed windows and units, explicit zeros, and no raw metadata", async () => {
	const capture = await captureLogs();
	try {
		const codex = gatewayLogContext(
			"codex-request",
			{ kind: "agent", agentAccountId: "pool" },
			"format",
			"openai-codex",
			"model",
		);
		logGatewayProviderResponse(codex, {
			status: 429,
			credentialId: 3,
			headers: {
				"Retry-After": "0",
				"x-private": secret.header,
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": "1900000000",
				"x-codex-secondary-used-percent": "0",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": "1900000000001",
			},
			metadata: { raw: secret.raw, body: secret.response, metadata: secret.metadata },
		});
		expect(capture.matching("auth-gateway quota observation").map(event => event.context)).toEqual([
			{
				...codex,
				status: 429,
				credentialId: 3,
				window: "primary",
				durationMs: 18000000,
				resetAtMs: 1900000000000,
				usedPercent: 100,
			},
			{
				...codex,
				status: 429,
				credentialId: 3,
				window: "secondary",
				durationMs: 604800000,
				resetAtMs: 1900000000001,
				usedPercent: 0,
			},
		]);
		const claude = gatewayLogContext(
			"claude-request",
			{ kind: "agent", agentAccountId: "pool" },
			"pi-native",
			"anthropic",
			"mapped-model",
		);
		logGatewayProviderResponse(
			claude,
			{
				status: 429,
				credentialId: 4,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "1",
					"anthropic-ratelimit-unified-5h-reset": "1900000000",
					"anthropic-ratelimit-unified-7d-utilization": "0",
					"anthropic-ratelimit-unified-7d-reset": "1900100000",
					"anthropic-ratelimit-unified-7d_oi-utilization": "0.5",
					"anthropic-ratelimit-requests-limit": "50",
					"anthropic-ratelimit-requests-remaining": "0",
					"anthropic-ratelimit-requests-reset": "2030-03-17T17:46:40Z",
					"anthropic-ratelimit-input-tokens-limit": "1000",
					"anthropic-ratelimit-input-tokens-remaining": "900",
					"anthropic-ratelimit-output-tokens-limit": "500",
					"anthropic-ratelimit-output-tokens-remaining": "500",
				},
			},
			"opus-5.5",
		);
		const observations = capture
			.matching("auth-gateway quota observation")
			.filter(event => event.context?.requestId === "claude-request");
		expect(observations.map(event => event.context?.window)).toEqual([
			"5h",
			"7d",
			"7d_oi",
			"requests",
			"input-tokens",
			"output-tokens",
		]);
		expect(observations[0]?.context?.resetAtMs).toBe(1900000000000);
		expect(observations[1]?.context?.usedPercent).toBe(0);
		expect(observations[3]?.context).toMatchObject({ limit: 50, remaining: 0 });
		await capture.assertSafe();
	} finally {
		await capture.close();
	}
});

test("absent, malformed, nonfinite, unmapped and credit-only observations do not invent quota", async () => {
	const capture = await captureLogs();
	try {
		for (const provider of ["openai-codex", "anthropic"]) {
			const context = gatewayLogContext(
				provider,
				{ kind: "agent", agentAccountId: "pool" },
				"test",
				provider,
				"unmapped",
			);
			for (const invalid of ["", "nonsense", "NaN", "Infinity", "-1", "1e309"]) {
				logGatewayProviderResponse(context, {
					status: 429,
					headers: {
						"retry-after": invalid,
						"retry-after-ms": invalid,
						"x-codex-primary-used-percent": invalid,
						"x-codex-primary-reset-at": invalid,
						"anthropic-ratelimit-unified-5h-utilization": invalid,
						"anthropic-ratelimit-unified-5h-reset": invalid,
						"anthropic-ratelimit-requests-limit": "10",
						"anthropic-ratelimit-requests-remaining": "0",
					},
				});
			}
			logGatewayProviderResponse(context, { status: 429, headers: {} });
			logGatewayAttemptFailure(
				context,
				undefined,
				new Error(`credit balance is too low ${secret.error}`),
				"terminal",
			);
		}
		expect(capture.matching("auth-gateway quota observation")).toHaveLength(0);
		for (const event of capture.matching("auth-gateway provider response")) {
			expect(event.context).not.toHaveProperty("retryAfterMs");
			expect(event.context).not.toHaveProperty("credentialId");
		}
		for (const event of capture.matching("auth-gateway provider attempt failed"))
			expect(event.context).not.toHaveProperty("resetAtMs");
		const context = gatewayLogContext(
			"invalid-api",
			{ kind: "agent", agentAccountId: "pool" },
			"test",
			"anthropic",
			"mapped",
		);
		logGatewayProviderResponse(
			context,
			{
				status: 429,
				headers: {
					"anthropic-ratelimit-requests-limit": "Infinity",
					"anthropic-ratelimit-requests-remaining": "NaN",
					"anthropic-ratelimit-requests-reset": "invalid",
				},
			},
			"opus-5.5",
		);
		expect(capture.matching("auth-gateway quota observation")).toHaveLength(0);
		logGatewayProviderResponse(context, {
			status: 429,
			headers: { "anthropic-ratelimit-unified-5h-reset": "1900000000" },
		});
		expect(capture.matching("auth-gateway quota observation").at(-1)?.context).toEqual({
			...context,
			status: 429,
			window: "5h",
			resetAtMs: 1900000000000,
		});
		const codex = gatewayLogContext(
			"reset-only",
			{ kind: "agent", agentAccountId: "pool" },
			"test",
			"openai-codex",
			"model",
		);
		logGatewayProviderResponse(codex, { status: 429, headers: { "x-codex-secondary-reset-at": "1900000000001" } });
		expect(capture.matching("auth-gateway quota observation").at(-1)?.context).toEqual({
			...codex,
			status: 429,
			window: "secondary",
			resetAtMs: 1900000000001,
		});
		logGatewayProviderResponse(
			context,
			{ status: 429, headers: { "anthropic-ratelimit-requests-remaining": " " } },
			"opus-5.5",
		);
		expect(capture.matching("auth-gateway quota observation")).toHaveLength(2);
		await capture.assertSafe();
	} finally {
		await capture.close();
	}
});
