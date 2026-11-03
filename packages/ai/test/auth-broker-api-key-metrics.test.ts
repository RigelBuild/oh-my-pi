import { describe, expect, test } from "bun:test";
import { renderApiKeyMetrics } from "@oh-my-pi/pi-ai/auth-broker/api-key-metrics";
import type { CredentialUsageTotal, StoredLimitObservation, UsageLimit } from "@oh-my-pi/pi-ai/usage";

const config = {
	roster: [1, 5],
	providers: ["anthropic"],
	modelClasses: ["opus-5.5"],
};

function total(
	credentialId: number,
	provider: string,
	credentialType: "api_key" | "oauth",
	metric: string,
	value: number,
): CredentialUsageTotal {
	return { credentialId, provider, credentialType, metric, value };
}

function limit(modelClass: string, id: string, used: number, at = 1_700_000_000_000): StoredLimitObservation {
	const normalized: UsageLimit = {
		id,
		label: "Requests",
		scope: { provider: "anthropic" },
		window: { id: "requests", label: "Requests", resetsAt: at + 60_000 },
		amount: { used, limit: 100, remaining: 100 - used, usedFraction: used / 100, unit: "requests" },
		status: "warning",
	};
	return {
		at,
		provider: "anthropic",
		credentialId: 1,
		credentialType: "api_key",
		modelClass,
		limits: [normalized],
	};
}

describe("renderApiKeyMetrics", () => {
	test("renders a complete exposition with bounded labels and exact Prometheus text", () => {
		const output = renderApiKeyMetrics(
			[total(4, "anthropic", "api_key", "requests:ok", 2)],
			[
				{
					at: 1_700_000_000_000,
					provider: "anthropic",
					credentialId: 4,
					credentialType: "api_key",
					modelClass: "opus-5.5",
					limits: [],
				},
			],
			{ roster: [4], providers: ["anthropic"], modelClasses: ["opus-5.5"] },
			[{ credentialId: 4, provider: "anthropic", credentialType: "api_key" }],
		);

		expect(output).toBe(
			"# HELP llm_gateway_requests_total Settled upstream requests by credential and outcome.\n" +
				"# TYPE llm_gateway_requests_total counter\n" +
				'llm_gateway_requests_total{provider="anthropic",account="credential:4",credential_type="api_key",outcome="ok"} 2\n' +
				"# HELP llm_api_key_report_fetched_at_seconds Unix time (seconds) of the newest observed API-key limit report.\n" +
				'# TYPE llm_api_key_report_fetched_at_seconds gauge\nllm_api_key_report_fetched_at_seconds{provider="anthropic",account="credential:4",model_class="opus-5.5"} 1700000000\n' +
				"# HELP llm_api_key_credit_exhausted Whether the newest API-key observation reports exhausted credit.\n" +
				'# TYPE llm_api_key_credit_exhausted gauge\nllm_api_key_credit_exhausted{provider="anthropic",account="credential:4"} 0\n' +
				"# HELP llm_api_key_credit_observed_at_seconds Unix time (seconds) of the newest observation behind llm_api_key_credit_exhausted.\n" +
				'# TYPE llm_api_key_credit_observed_at_seconds gauge\nllm_api_key_credit_observed_at_seconds{provider="anthropic",account="credential:4"} 1700000000\n',
		);
	});

	test("sums unrostered credentials and unconfigured providers without losing auth classes", () => {
		const output = renderApiKeyMetrics(
			[
				total(1, "anthropic", "api_key", "tokens:input", 2),
				total(1, "anthropic", "api_key", "tokens:input", 3),
				total(2, "anthropic", "oauth", "tokens:input", 5),
				total(3, "other-provider", "oauth", "tokens:input", 7),
				total(4, "another-provider", "api_key", "tokens:input", 11),
			],
			[],
			config,
		);

		expect(output).toContain(
			'llm_gateway_tokens_total{provider="anthropic",account="credential:1",credential_type="api_key",token_kind="input"} 5',
		);
		expect(output).toContain(
			'llm_gateway_tokens_total{provider="anthropic",account="unknown",credential_type="oauth",token_kind="input"} 5',
		);
		expect(output).toContain(
			'llm_gateway_tokens_total{provider="other",account="unknown",credential_type="oauth",token_kind="input"} 7',
		);
		expect(output).toContain(
			'llm_gateway_tokens_total{provider="other",account="unknown",credential_type="api_key",token_kind="input"} 11',
		);
		expect(output).not.toContain("other-provider");
		expect(output).not.toContain("another-provider");
	});

	test("preserves oauth and api-key credential classes in request counters", () => {
		const output = renderApiKeyMetrics(
			[total(1, "anthropic", "oauth", "requests:aborted", 2), total(5, "anthropic", "api_key", "requests:error", 3)],
			[],
			config,
		);
		expect(output).toContain(
			'llm_gateway_requests_total{provider="anthropic",account="credential:1",credential_type="oauth",outcome="aborted"} 2',
		);
		expect(output).toContain(
			'llm_gateway_requests_total{provider="anthropic",account="credential:5",credential_type="api_key",outcome="error"} 3',
		);
	});

	test("exports selected per-model limits and newest per-row credit status only", () => {
		const output = renderApiKeyMetrics(
			[
				total(1, "anthropic", "api_key", "estimated_cost_usd", 0.25),
				total(5, "anthropic", "api_key", "requests:error", 1),
				total(6, "anthropic", "oauth", "tokens:output", 90),
			],
			[
				{ ...limit("opus-5.5", "anthropic:api:opus-5.5:requests", 20), credentialId: 1 },
				{
					...limit("opus-5.5", "anthropic:api:opus-5.5:requests", 30, 1_700_000_060_000),
					credentialId: 1,
					error: "credit_exhausted",
				},
				{
					...limit("opus-5.5", "anthropic:api:opus-5.5:input-tokens", 40),
					credentialId: 1,
				},
				{
					...limit("opus-5.4", "anthropic:api:opus-5.4:requests", 50),
					credentialId: 1,
				},
				{
					...limit("opus-5.5", "anthropic:api:opus-5.5:requests", 60),
					credentialId: 99,
				},
				{
					...limit("opus-5.5", "anthropic:api:opus-5.5:requests", 10, 1_700_000_030_000),
					credentialId: 5,
					error: "rate_limited",
				},
			],
			config,
			[
				{ credentialId: 1, provider: "anthropic", credentialType: "api_key" },
				{ credentialId: 5, provider: "anthropic", credentialType: "api_key" },
			],
		);

		expect(output).toContain(
			'llm_api_key_limit_used_fraction{provider="anthropic",account="credential:1",model_class="opus-5.5",limit_id="anthropic:api:opus-5.5:requests"} 0.3',
		);
		expect(output).toContain(
			'llm_api_key_limit_used{provider="anthropic",account="credential:1",model_class="opus-5.5",limit_id="anthropic:api:opus-5.5:requests"} 30',
		);
		expect(output).toContain(
			'llm_api_key_limit_status{provider="anthropic",account="credential:1",model_class="opus-5.5",limit_id="anthropic:api:opus-5.5:requests"} 1',
		);
		expect(output).toContain(
			'llm_api_key_report_fetched_at_seconds{provider="anthropic",account="credential:1",model_class="opus-5.5"} 1700000060',
		);
		expect(output).toContain('llm_api_key_credit_exhausted{provider="anthropic",account="credential:1"} 1\n');
		expect(output).toContain(
			'llm_api_key_credit_observed_at_seconds{provider="anthropic",account="credential:1"} 1700000060\n',
		);
		expect(output).toContain('llm_api_key_credit_exhausted{provider="anthropic",account="credential:5"} 0\n');
		expect(output).toContain(
			'llm_api_key_credit_observed_at_seconds{provider="anthropic",account="credential:5"} 1700000030\n',
		);
		expect(output).toContain(
			'llm_gateway_estimated_cost_usd_total{provider="anthropic",account="credential:1",credential_type="api_key"} 0.25',
		);
		expect(output).not.toContain("opus-5.4");
		expect(output).not.toContain('account="credential:99"');
		expect(output).not.toContain('account="credential:6"');
	});
});
