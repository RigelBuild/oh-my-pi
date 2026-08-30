import { describe, expect, test } from "bun:test";
import {
	accountLabelOf,
	emailLabelOf,
	nextRenewalSeconds,
	renderUsageMetrics,
	UNIDENTIFIED_ACCOUNT,
} from "@oh-my-pi/pi-ai/auth-broker/prometheus-metrics";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

// A Claude report on the profile path: accountId in metadata, two shared
// windows (5h + 7d) plus a model-scoped weekly row. resetsAt in ms.
function claudeReport(): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: 1_700_000_000_000,
		metadata: { endpoint: "https://api.anthropic.com", accountId: "acct-claude-1", email: "a@example.com" },
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_000_900_000 },
				amount: {
					used: 42,
					limit: 100,
					remaining: 58,
					usedFraction: 0.42,
					remainingFraction: 0.58,
					unit: "percent",
				},
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: 1_700_500_000_000 },
				amount: {
					used: 95,
					limit: 100,
					remaining: 5,
					usedFraction: 0.95,
					remainingFraction: 0.05,
					unit: "percent",
				},
				status: "warning",
			},
		],
	};
}

// A Codex report: accountId in metadata, resetCredits present, one limit with
// no status (must map to -1) and no window (window label "").
function codexReport(): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: 1_700_000_060_000,
		metadata: { planType: "pro", accountId: "acct-codex-9", email: "c@example.com" },
		resetCredits: { availableCount: 3 },
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", resetsAt: 1_700_000_900_000 },
				amount: { used: 10, limit: 100, remaining: 90, usedFraction: 0.1, unit: "percent" },
				status: "exhausted",
			},
			{
				id: "openai-codex:extra",
				label: "Extra",
				scope: { provider: "openai-codex" },
				amount: { usedFraction: 0.5, unit: "percent" },
				// no status -> -1
			},
		],
	};
}

describe("renderUsageMetrics", () => {
	test("emits every llm_usage_ family with bounded labels including account and email", () => {
		const out = renderUsageMetrics([claudeReport(), codexReport()]);

		// Headers present, TYPE gauge.
		expect(out).toContain("# HELP llm_usage_limit_used_fraction");
		expect(out).toContain("# TYPE llm_usage_limit_used_fraction gauge");

		// used_fraction keyed on {provider, account, email, limit_id, window}.
		expect(out).toContain(
			'llm_usage_limit_used_fraction{provider="anthropic",account="acct-claude-1",email="a@example.com",limit_id="anthropic:5h",window="5h"} 0.42',
		);
		// resets_at converted ms -> s.
		expect(out).toContain(
			'llm_usage_limit_resets_at_seconds{provider="anthropic",account="acct-claude-1",email="a@example.com",limit_id="anthropic:5h",window="5h"} 1700000900',
		);
		// status enum: ok=0, warning=1, exhausted=2.
		expect(out).toContain(
			'llm_usage_limit_status{provider="anthropic",account="acct-claude-1",email="a@example.com",limit_id="anthropic:5h",window="5h"} 0',
		);
		expect(out).toContain(
			'llm_usage_limit_status{provider="anthropic",account="acct-claude-1",email="a@example.com",limit_id="anthropic:7d",window="7d"} 1',
		);
		expect(out).toContain(
			'llm_usage_limit_status{provider="openai-codex",account="acct-codex-9",email="c@example.com",limit_id="openai-codex:primary",window="5h"} 2',
		);
		// raw amount families carry unit label.
		expect(out).toContain(
			'llm_usage_limit_used{provider="anthropic",account="acct-claude-1",email="a@example.com",limit_id="anthropic:5h",window="5h",unit="percent"} 42',
		);
		// reset credits keyed on {provider, account, email} only.
		expect(out).toContain(
			'llm_usage_reset_credits_available{provider="openai-codex",account="acct-codex-9",email="c@example.com"} 3',
		);
		// fetched_at per account, ms -> s.
		expect(out).toContain(
			'llm_usage_report_fetched_at_seconds{provider="anthropic",account="acct-claude-1",email="a@example.com"} 1700000000',
		);
		// Email is exported by design: the account UUID is opaque, so the email
		// label is what makes a subscription account legible on the dashboard.
		expect(out).toContain('email="a@example.com"');
		expect(out).toContain('email="c@example.com"');
	});

	test('absent status maps to -1, and a windowless limit emits window=""', () => {
		const out = renderUsageMetrics([codexReport()]);
		expect(out).toContain(
			'llm_usage_limit_status{provider="openai-codex",account="acct-codex-9",email="c@example.com",limit_id="openai-codex:extra",window=""} -1',
		);
		// A limit with no window/resetsAt emits no resets_at series for it.
		expect(out).not.toContain(
			'llm_usage_limit_resets_at_seconds{provider="openai-codex",account="acct-codex-9",email="c@example.com",limit_id="openai-codex:extra"',
		);
		// used_fraction still emitted for the windowless limit.
		expect(out).toContain(
			'llm_usage_limit_used_fraction{provider="openai-codex",account="acct-codex-9",email="c@example.com",limit_id="openai-codex:extra",window=""} 0.5',
		);
	});

	test("empty reports render an empty (but valid) exposition", () => {
		expect(renderUsageMetrics([])).toBe("");
	});

	test("a limit with no amount values emits only status", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-x" },
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { unit: "unknown" },
					status: "unknown",
				},
			],
		};
		const out = renderUsageMetrics([report]);
		// unknown status -> -1; no email in metadata -> email="".
		expect(out).toContain(
			'llm_usage_limit_status{provider="anthropic",account="acct-x",email="",limit_id="anthropic:5h",window="5h"} -1',
		);
		// no used_fraction, used, max, remaining, resets_at families for this limit
		expect(out).not.toContain("llm_usage_limit_used_fraction");
		expect(out).not.toContain("llm_usage_limit_used{");
		expect(out).not.toContain("llm_usage_limit_resets_at_seconds");
	});

	test("escapes label values", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: 'quote"and\\slash' },
			limits: [
				{
					id: "anthropic:5h",
					label: "x",
					scope: { provider: "anthropic" },
					amount: { usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
			],
		};
		const out = renderUsageMetrics([report]);
		expect(out).toContain('account="quote\\"and\\\\slash"');
		// No email in metadata -> the label is still emitted, empty.
		expect(out).toContain('email=""');
	});

	test("escapes the email label value", () => {
		// A newline in the value is the dangerous one: unescaped it splits the
		// sample across two physical lines and fails the whole scrape at parse.
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-esc", email: 'quote"and\\slash\nnewline@example.com' },
			limits: [
				{
					id: "anthropic:5h",
					label: "x",
					scope: { provider: "anthropic" },
					amount: { usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
			],
		};
		const out = renderUsageMetrics([report]);
		expect(out).toContain('email="quote\\"and\\\\slash\\nnewline@example.com"');
		// Every sample line is whole: the newline never breaks one in two.
		const sampleLines = out.split("\n").filter(line => line.startsWith("llm_usage_"));
		expect(sampleLines.length).toBeGreaterThan(0);
		for (const line of sampleLines) {
			expect(line).toContain('email="quote\\"and\\\\slash\\nnewline@example.com"');
		}
	});

	test("drops a duplicate {name,labels} series and notes it", () => {
		// Two limits that produce the identical {provider,account,email,limit_id,window}
		// key — a duplicate sample would fail the whole scrape at parse.
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-dup" },
			limits: [
				{
					id: "openai-codex:dup",
					label: "A",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
				{
					id: "openai-codex:dup",
					label: "B",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { usedFraction: 0.9, unit: "percent" },
					status: "warning",
				},
			],
		};
		const out = renderUsageMetrics([report]);
		// First wins (0.1), duplicate dropped, note emitted.
		expect(out).toContain(
			'llm_usage_limit_used_fraction{provider="openai-codex",account="acct-dup",email="",limit_id="openai-codex:dup",window="5h"} 0.1',
		);
		expect(out).not.toContain("} 0.9");
		expect(out).toContain("# note duplicate series dropped: llm_usage_limit_used_fraction");
	});

	test("escapes the limit_id in the duplicate-series note", () => {
		// `limit_id` is provider data and reaches the `# note` line on a collision.
		// A raw newline in it would split the note into a second physical line that
		// is neither a comment nor a valid sample, failing the whole scrape at parse.
		const hostileId = 'dup"a\\b\nc';
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-dup" },
			limits: [
				{
					id: hostileId,
					label: "A",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
				{
					id: hostileId,
					label: "B",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { usedFraction: 0.9, unit: "percent" },
					status: "warning",
				},
			],
		};
		const out = renderUsageMetrics([report]);
		expect(out).toContain(
			'# note duplicate series dropped: llm_usage_limit_used_fraction{limit_id="dup\\"a\\\\b\\nc"}',
		);
		// Every physical line is still a comment or a sample.
		for (const line of out.split("\n").filter(l => l.length > 0)) {
			expect(line.startsWith("#") || /^llm_usage_\w+\{/.test(line)).toBe(true);
		}
	});

	test("every emitted line is a comment or a sample, even when the email holds a newline", () => {
		// The note path once concatenated raw label values, so a newline in the
		// email emitted a second physical line that is neither a `#` comment nor
		// a valid sample — the whole scrape fails at parse, not just this series.
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-dup", email: "leak\nlocal@example.com" },
			limits: [
				{
					id: "openai-codex:dup",
					label: "A",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
				{
					id: "openai-codex:dup",
					label: "B",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { usedFraction: 0.9, unit: "percent" },
					status: "warning",
				},
			],
		};
		const out = renderUsageMetrics([report]);
		// The collision fired, so the note path is exercised by this render.
		expect(out).toContain("duplicate series dropped: ");

		const lines = out.split("\n").filter(line => line.length > 0);
		for (const line of lines) {
			if (line.startsWith("#")) continue;
			expect(line).toMatch(/^llm_usage_\w+\{/);
		}

		// The comment stream is not a PII surface: the email is a label, never
		// a value echoed into a note.
		for (const line of lines.filter(l => l.startsWith("#"))) {
			expect(line).not.toContain("leak");
			expect(line).not.toContain("local");
			expect(line).not.toContain("example.com");
		}
	});

	test("canonicalizes the email label so case/whitespace variants are one series", () => {
		// Same account seen twice with a differently-cased, padded email. If the
		// label were emitted verbatim the two reports would produce two distinct
		// per-account series instead of one collision.
		const base = (email: string): UsageReport => ({
			provider: "anthropic",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-canon", email },
			limits: [],
		});
		const out = renderUsageMetrics([base("  A.User@Example.COM  "), base("a.user@example.com")]);

		expect(out).toContain(
			'llm_usage_report_fetched_at_seconds{provider="anthropic",account="acct-canon",email="a.user@example.com"} 1700000000',
		);
		expect(out).not.toContain("A.User@Example.COM");
		// One series, not two: the second report collided and was dropped.
		expect(out).toContain("duplicate series dropped: ");
		const samples = out.split("\n").filter(line => line.startsWith("llm_usage_report_fetched_at_seconds{"));
		expect(samples.length).toBe(1);
	});

	test("label values with commas or = do not forge a dedup collision", () => {
		// The dedup key once comma-joined raw `k=v` fragments, so a value holding
		// `,` or `=` could forge a fragment boundary:
		//   (account="x,email=y", email="z")  and
		//   (account="x", email="y,email=z")
		// serialize to the same "account=x,email=y,email=z,provider=..." string,
		// dropping the second as a phantom duplicate. These are two distinct
		// series and both must survive.
		const report = (accountId: string, email: string, fetchedAt: number): UsageReport => ({
			provider: "anthropic",
			fetchedAt,
			metadata: { accountId, email },
			limits: [],
		});
		const out = renderUsageMetrics([
			report("x,email=y", "z", 1_700_000_000_000),
			report("x", "y,email=z", 1_700_000_060_000),
		]);

		const samples = out.split("\n").filter(line => line.startsWith("llm_usage_report_fetched_at_seconds{"));
		expect(samples.length).toBe(2);
		expect(out).not.toContain("duplicate series dropped: ");
	});

	test("emits the email label on every sample, including reports that carry none", () => {
		// A label present on some samples of a family and absent on others is an
		// inconsistent label set; the scrape fails at parse.
		const withEmail = claudeReport();
		const withoutEmail = codexReport();
		withoutEmail.metadata = { planType: "pro", accountId: "acct-codex-9" };

		const out = renderUsageMetrics([withEmail, withoutEmail]);
		const samples = out.split("\n").filter(line => line.length > 0 && !line.startsWith("#"));
		expect(samples.length).toBeGreaterThan(0);
		for (const line of samples) expect(line).toContain("email=");
		// The email-less report still emits the label, empty.
		expect(out).toContain('account="acct-codex-9",email=""');
	});

	test("emits the four llm_subscription_ families with canonicalized plan labels from a populated config", () => {
		// Feed a non-canonical plan string; it must render canonicalized to match
		// getUsagePlanType (trim / lowercase / [\s-]+ -> _ / strip chatgpt_).
		const subscriptions = {
			lookup: (provider: string, account: string) =>
				provider === "anthropic" && account === "acct-claude-1"
					? { plan: "Max 20x", renewsAtSeconds: 1_760_000_000 }
					: undefined,
			plans: [{ provider: "anthropic", plan: "max-20x", capacityWeight: 4, monthlyPriceUsd: 200 }],
		};
		const out = renderUsageMetrics([claudeReport()], { subscriptions, now: () => 1_760_000_000_000 });

		expect(out).toContain("# TYPE llm_subscription_info gauge");
		expect(out).toContain(
			'llm_subscription_info{provider="anthropic",account="acct-claude-1",email="a@example.com",plan="max_20x"} 1',
		);
		// The anchor 1_760_000_000 is 2025-10-09 08:53:20 UTC; the renderer rolls
		// it forward date-only, flooring to UTC midnight, and with `now` pinned to
		// the anchor instant the current occurrence is that same day's midnight.
		expect(out).toContain(
			`llm_subscription_renews_at_seconds{provider="anthropic",account="acct-claude-1",email="a@example.com"} ${
				Date.UTC(2025, 9, 9) / 1000
			}`,
		);
		// Per-plan facts carry only {provider, plan}, plan canonicalized identically.
		expect(out).toContain('llm_subscription_plan_capacity_weight{provider="anthropic",plan="max_20x"} 4');
		expect(out).toContain('llm_subscription_plan_price_usd{provider="anthropic",plan="max_20x"} 200');
	});

	test("a Codex report with no config plan falls back to the parsed planType", () => {
		// codexReport() has metadata.planType "pro"; the config entry omits plan.
		const subscriptions = {
			lookup: (provider: string, account: string) =>
				provider === "openai-codex" && account === "acct-codex-9" ? {} : undefined,
			plans: [],
		};
		const out = renderUsageMetrics([codexReport()], { subscriptions });
		expect(out).toContain(
			'llm_subscription_info{provider="openai-codex",account="acct-codex-9",email="c@example.com",plan="pro"} 1',
		);
		// A configured account WITHOUT renewsAtSeconds must emit no renewal gauge
		// (undefined stays undefined through the roll-forward callsite).
		expect(out).not.toContain('llm_subscription_renews_at_seconds{provider="openai-codex"');
	});

	test("an empty subscription config renders byte-identical to no config", () => {
		const reports = [claudeReport(), codexReport()];
		const emptySubscriptions = { lookup: () => undefined, plans: [] };
		expect(renderUsageMetrics(reports, { subscriptions: emptySubscriptions })).toBe(renderUsageMetrics(reports));
		expect(renderUsageMetrics(reports, { subscriptions: emptySubscriptions })).not.toContain("llm_subscription_");
	});

	test("two accounts on one plan emit exactly one weight and one price series", () => {
		const second: UsageReport = {
			...claudeReport(),
			metadata: { accountId: "acct-claude-2", email: "b@example.com" },
		};
		const subscriptions = {
			lookup: (provider: string, account: string) =>
				provider === "anthropic" && (account === "acct-claude-1" || account === "acct-claude-2")
					? { plan: "max_20x" }
					: undefined,
			plans: [{ provider: "anthropic", plan: "max_20x", capacityWeight: 4, monthlyPriceUsd: 200 }],
		};
		const out = renderUsageMetrics([claudeReport(), second], { subscriptions });

		// Two info series (one per account) but exactly one of each per-plan family.
		const infoLines = out.split("\n").filter(line => line.startsWith("llm_subscription_info{"));
		expect(infoLines.length).toBe(2);
		const weightLines = out.split("\n").filter(line => line.startsWith("llm_subscription_plan_capacity_weight{"));
		expect(weightLines.length).toBe(1);
		const priceLines = out.split("\n").filter(line => line.startsWith("llm_subscription_plan_price_usd{"));
		expect(priceLines.length).toBe(1);
	});
});

describe("nextRenewalSeconds", () => {
	test("a strictly-future anchor is returned unchanged", () => {
		const anchor = Date.UTC(2027, 0, 15) / 1000; // 2027-01-15
		const now = Date.UTC(2026, 7, 5) / 1000; // 2026-08-05
		expect(nextRenewalSeconds(anchor, now)).toBe(anchor);
	});

	test("a strictly-past anchor advances to the next occurrence at-or-after now", () => {
		const anchor = Date.UTC(2026, 0, 15) / 1000; // 2026-01-15
		const now = Date.UTC(2026, 7, 5) / 1000; // 2026-08-05
		expect(nextRenewalSeconds(anchor, now)).toBe(Date.UTC(2026, 7, 15) / 1000); // 2026-08-15
	});

	test("on the renewal day itself the anchor is returned (bill is today)", () => {
		const anchor = Date.UTC(2026, 5, 15) / 1000; // 2026-06-15
		const now = Date.UTC(2026, 5, 15) / 1000; // 2026-06-15
		expect(nextRenewalSeconds(anchor, now)).toBe(anchor);
	});

	test("a 31st anchor clamps to the last day of a shorter target month", () => {
		const anchor = Date.UTC(2026, 0, 31) / 1000; // 2026-01-31
		const now = Date.UTC(2026, 1, 1) / 1000; // 2026-02-01
		expect(nextRenewalSeconds(anchor, now)).toBe(Date.UTC(2026, 1, 28) / 1000); // 2026-02-28
	});

	test("a month clamped short recovers the anchor day in a later long month (no cumulative drift)", () => {
		// Jan-31 anchor: Feb clamps to 28, but March must recover the true day 31,
		// not stay one day early. The impl recomputes each candidate from the fixed
		// anchor day, so a drift-prone reimplementation is caught here.
		const anchor = Date.UTC(2026, 0, 31) / 1000; // 2026-01-31
		const now = Date.UTC(2026, 2, 1) / 1000; // 2026-03-01, past the Feb clamp
		expect(nextRenewalSeconds(anchor, now)).toBe(Date.UTC(2026, 2, 31) / 1000); // 2026-03-31, NOT 03-28
	});

	test("a 31st anchor clamps to Feb-29 in a leap year", () => {
		const anchor = Date.UTC(2024, 0, 31) / 1000; // 2024-01-31
		const now = Date.UTC(2024, 1, 1) / 1000; // 2024-02-01
		expect(nextRenewalSeconds(anchor, now)).toBe(Date.UTC(2024, 1, 29) / 1000); // 2024-02-29
	});

	test("a December anchor rolls over into the next year", () => {
		const anchor = Date.UTC(2025, 11, 15) / 1000; // 2025-12-15
		const now = Date.UTC(2026, 0, 1) / 1000; // 2026-01-01
		expect(nextRenewalSeconds(anchor, now)).toBe(Date.UTC(2026, 0, 15) / 1000); // 2026-01-15
	});

	test("renderUsageMetrics emits the rolled-forward renewal, not the raw past anchor", () => {
		const subscriptions = {
			lookup: (provider: string, account: string) =>
				provider === "anthropic" && account === "acct-claude-1"
					? { plan: "max_20x", renewsAtSeconds: 1_760_000_000 } // anchor 2025-10-09
					: undefined,
			plans: [],
		};
		const now = () => Date.UTC(2026, 7, 5); // 2026-08-05, epoch ms
		const out = renderUsageMetrics([claudeReport()], { subscriptions, now });
		const expected = Date.UTC(2026, 7, 9) / 1000; // 2026-08-09, next day-9 at-or-after now
		expect(out).toContain(
			`llm_subscription_renews_at_seconds{provider="anthropic",account="acct-claude-1",email="a@example.com"} ${expected}`,
		);
	});
});

describe("accountLabelOf", () => {
	test("prefers metadata.accountId", () => {
		expect(accountLabelOf(claudeReport())).toBe("acct-claude-1");
		expect(accountLabelOf(codexReport())).toBe("acct-codex-9");
	});

	test("falls back to a limit scope.accountId when metadata lacks one", () => {
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 1,
			metadata: { planType: "pro" },
			limits: [
				{
					id: "openai-codex:extra:primary",
					label: "Extra",
					scope: { provider: "openai-codex", accountId: "scope-acct" },
					amount: { usedFraction: 0.1, unit: "percent" },
				},
			],
		};
		expect(accountLabelOf(report)).toBe("scope-acct");
		// The report carries no email, so the exposition emits email="".
		const out = renderUsageMetrics([report]);
		expect(out).toContain(
			'llm_usage_limit_used_fraction{provider="openai-codex",account="scope-acct",email="",limit_id="openai-codex:extra:primary",window=""} 0.1',
		);
	});

	test("falls back to the unidentified sentinel (Claude ratelimit-header path)", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1,
			metadata: { source: "ratelimit-headers" },
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					amount: { usedFraction: 0.1, unit: "percent" },
				},
			],
		};
		expect(accountLabelOf(report)).toBe(UNIDENTIFIED_ACCOUNT);
		expect(accountLabelOf(report)).toBe("unidentified");
	});

	test("never uses an email as the *account* label value", () => {
		// Scoped to the account label only: an email is never a substitute for
		// an accountId here. Email IS exported, but as its own `email` label.
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1,
			metadata: { email: "secret@example.com" },
			limits: [],
		};
		expect(accountLabelOf(report)).toBe(UNIDENTIFIED_ACCOUNT);
	});
});

describe("emailLabelOf", () => {
	test("returns metadata.email when present", () => {
		expect(emailLabelOf(claudeReport())).toBe("a@example.com");
		expect(emailLabelOf(codexReport())).toBe("c@example.com");
	});

	test('returns "" when metadata carries no email', () => {
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 1,
			metadata: { planType: "pro", accountId: "acct-codex-9" },
			limits: [],
		};
		expect(emailLabelOf(report)).toBe("");
	});

	test('returns "" when metadata is absent entirely', () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1,
			limits: [],
		};
		expect(emailLabelOf(report)).toBe("");
	});

	test('returns "" for a non-string email value', () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1,
			metadata: { email: 42 },
			limits: [],
		};
		expect(emailLabelOf(report)).toBe("");
	});
});
