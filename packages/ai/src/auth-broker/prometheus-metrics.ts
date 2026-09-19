import type { UsageLimit, UsageReport, UsageStatus } from "../usage";
import { resolveUsedFraction } from "../usage";

/** Content-type for a Prometheus v0.0.4 text exposition response. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Sentinel account label when a report carries no stable account id. */
export const UNIDENTIFIED_ACCOUNT = "unidentified";

export function accountLabelOf(report: UsageReport): string {
	const metaId = report.metadata?.accountId;
	if (typeof metaId === "string" && metaId.length > 0) return metaId;
	for (const limit of report.limits) {
		const scopeId = limit.scope.accountId;
		if (typeof scopeId === "string" && scopeId.length > 0) return scopeId;
	}
	return UNIDENTIFIED_ACCOUNT;
}

export function emailLabelOf(report: UsageReport): string {
	const email = report.metadata?.email;
	if (typeof email === "string") return email.trim().toLowerCase();
	return "";
}

/** Numeric gauge value per usage status; absent AND `unknown` both map to -1. */
const STATUS_VALUE: Record<UsageStatus, number> = {
	ok: 0,
	warning: 1,
	exhausted: 2,
	unknown: -1,
};

/** Format a numeric sample value; Go-parseable floats incl. the Inf/NaN forms. */
function formatValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (value === Number.POSITIVE_INFINITY) return "+Inf";
	if (value === Number.NEGATIVE_INFINITY) return "-Inf";
	return String(value);
}

type Label = readonly [string, string];

/** Escape a label value for text exposition: backslash, quote, then newline. */
function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: readonly Label[]): string {
	if (labels.length === 0) return "";
	const inner = labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
	return `{${inner}}`;
}

interface Sample {
	readonly labels: readonly Label[];
	readonly value: number;
}

interface MetricFamily {
	readonly name: string;
	readonly help: string;
	readonly samples: Sample[];
}

export interface SubscriptionLookup {
	/** Per-account facts, or `undefined` when the account is not configured. */
	lookup(provider: string, account: string): { plan?: string; renewsAtSeconds?: number } | undefined;
	/** Per-plan facts; emitted once per `{provider, plan}`, outside the per-report loop. */
	plans: ReadonlyArray<{ provider: string; plan: string; capacityWeight: number; monthlyPriceUsd: number }>;
}

function canonicalizePlan(plan: string): string {
	const normalized = plan.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return normalized.startsWith("chatgpt_") ? normalized.slice("chatgpt_".length) : normalized;
}

/**
 * Given a renewal ANCHOR (unix seconds, a known past-or-future bill date) and
 * the current time (unix seconds), return the next renewal at or after `now`,
 * advancing by whole calendar months. Anniversary billing: the anchor's
 * day-of-month is preserved and clamped to the last day of a shorter target
 * month (e.g. a 31st anchor renews on Feb 28). Day-granularity in UTC — on the
 * renewal day itself the anchor is returned (the bill is today), and only a
 * strictly-past day rolls forward. Matches the parser's UTC date-only anchors.
 */
export function nextRenewalSeconds(anchorSec: number, nowSec: number): number {
	const anchor = new Date(anchorSec * 1000);
	const y = anchor.getUTCFullYear();
	const m = anchor.getUTCMonth();
	const d = anchor.getUTCDate();
	// Floor `now` to its UTC calendar day so the comparison is day-granular.
	const now = new Date(nowSec * 1000);
	const nowDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	for (let k = 0; ; k += 1) {
		// Last day of the k-th month after the anchor month, to clamp the day.
		const lastDay = new Date(Date.UTC(y, m + k + 1, 0)).getUTCDate();
		const candidateMs = Date.UTC(y, m + k, Math.min(d, lastDay));
		if (candidateMs >= nowDayMs) return candidateMs / 1000;
	}
}

export function renderUsageMetrics(
	reports: readonly UsageReport[],
	opts: {
		accountLabel?: (report: UsageReport) => string;
		emailLabel?: (report: UsageReport) => string;
		subscriptions?: SubscriptionLookup;
		/** Override clock (tests); epoch ms. */
		now?: () => number;
	} = {},
): string {
	const accountLabel = opts.accountLabel ?? accountLabelOf;
	const emailLabel = opts.emailLabel ?? emailLabelOf;
	const subscriptions = opts.subscriptions ?? { lookup: () => undefined, plans: [] };
	const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);

	// Families in canonical emission order. `_used`/`_max`/`_remaining` carry an
	// extra `unit` label; the others key on {provider, account, email, limit_id,
	// window} (or {provider, account, email} for the per-report families).
	const families: MetricFamily[] = [
		{
			name: "llm_usage_limit_used_fraction",
			help: "Fraction (0..1) of a usage limit consumed; >1 means overage.",
			samples: [],
		},
		{ name: "llm_usage_limit_used", help: "Amount used for a usage limit, in the series unit label.", samples: [] },
		{ name: "llm_usage_limit_max", help: "Maximum for a usage limit, in the series unit label.", samples: [] },
		{
			name: "llm_usage_limit_remaining",
			help: "Remaining amount for a usage limit, in the series unit label.",
			samples: [],
		},
		{
			name: "llm_usage_limit_resets_at_seconds",
			help: "Unix time (seconds) at which a usage-limit window resets.",
			samples: [],
		},
		{
			name: "llm_usage_limit_status",
			help: "Usage-limit status: 0 ok, 1 warning, 2 exhausted, -1 unknown.",
			samples: [],
		},
		{
			name: "llm_usage_reset_credits_available",
			help: "Saved rate-limit resets an account can redeem right now.",
			samples: [],
		},
		{
			name: "llm_usage_report_fetched_at_seconds",
			help: "Unix time (seconds) the usage report for an account was last fetched.",
			samples: [],
		},
		{
			name: "llm_subscription_info",
			help: "Subscription plan for an account; value 1, plan carried as a label.",
			samples: [],
		},
		{
			name: "llm_subscription_renews_at_seconds",
			help: "Unix time (seconds) at which a subscription next renews (bills).",
			samples: [],
		},
		{
			name: "llm_subscription_plan_capacity_weight",
			help: "Relative capacity multiple of a subscription plan vs the baseline plan.",
			samples: [],
		},
		{
			name: "llm_subscription_plan_price_usd",
			help: "Monthly list price (USD) of a subscription plan.",
			samples: [],
		},
	];
	const byName = new Map(families.map(f => [f.name, f]));
	// Per-family seen-key set: a duplicate {name, labels} fails the WHOLE scrape
	// at parse, so drop-and-note the collision rather than emit it or suffix it.
	const seen = new Map<string, Set<string>>(families.map(f => [f.name, new Set<string>()]));
	const notes: string[] = [];

	const add = (name: string, labels: readonly Label[], value: number | undefined): void => {
		if (value === undefined) return;
		const family = byName.get(name);
		const seenSet = seen.get(name);
		if (!family || !seenSet) return;
		const key = [...labels]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}=${v}`)
			.join(",");
		if (seenSet.has(key)) {
			// Identify the collided family and its `limit_id` only: a note is a
			// comment line, so any raw label value here would both escape the
			// exposition escaping and leak the address into a non-sample line.
			const limitId = labels.find(([k]) => k === "limit_id")?.[1];
			notes.push(
				limitId === undefined
					? `duplicate series dropped: ${name}`
					: `duplicate series dropped: ${name}{limit_id="${escapeLabelValue(limitId)}"}`,
			);
			return;
		}
		seenSet.add(key);
		family.samples.push({ labels, value });
	};

	for (const report of reports) {
		const provider = report.provider;
		const account = accountLabel(report);
		const email = emailLabel(report);
		const perAccount: readonly Label[] = [
			["provider", provider],
			["account", account],
			["email", email],
		];

		add("llm_usage_report_fetched_at_seconds", perAccount, report.fetchedAt / 1000);
		if (report.resetCredits) {
			add("llm_usage_reset_credits_available", perAccount, report.resetCredits.availableCount);
		}

		const subscription = subscriptions.lookup(provider, account);
		if (subscription) {
			const rawPlan = subscription.plan ?? report.metadata?.planType;
			const plan = typeof rawPlan === "string" ? canonicalizePlan(rawPlan) : undefined;
			if (plan !== undefined) {
				add("llm_subscription_info", [...perAccount, ["plan", plan]], 1);
			}
			add(
				"llm_subscription_renews_at_seconds",
				perAccount,
				subscription.renewsAtSeconds === undefined
					? undefined
					: nextRenewalSeconds(subscription.renewsAtSeconds, nowSec),
			);
		}

		for (const limit of report.limits) {
			const base: readonly Label[] = [
				["provider", provider],
				["account", account],
				["email", email],
				["limit_id", limit.id],
				["window", limit.window?.id ?? ""],
			];
			addLimit(add, base, limit);
		}
	}

	for (const { provider, plan, capacityWeight, monthlyPriceUsd } of subscriptions.plans) {
		const planLabels: readonly Label[] = [
			["provider", provider],
			["plan", canonicalizePlan(plan)],
		];
		add("llm_subscription_plan_capacity_weight", planLabels, capacityWeight);
		add("llm_subscription_plan_price_usd", planLabels, monthlyPriceUsd);
	}

	const lines: string[] = [];
	for (const family of families) {
		if (family.samples.length === 0) continue;
		lines.push(`# HELP ${family.name} ${family.help}`);
		lines.push(`# TYPE ${family.name} gauge`);
		for (const sample of family.samples) {
			lines.push(`${family.name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
		}
	}
	for (const note of notes) lines.push(`# note ${note}`);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Emit the per-limit families for one {@link UsageLimit} under `base` labels. */
function addLimit(
	add: (name: string, labels: readonly Label[], value: number | undefined) => void,
	base: readonly Label[],
	limit: UsageLimit,
): void {
	add("llm_usage_limit_used_fraction", base, resolveUsedFraction(limit));

	const withUnit: readonly Label[] = [...base, ["unit", limit.amount.unit]];
	add("llm_usage_limit_used", withUnit, limit.amount.used);
	add("llm_usage_limit_max", withUnit, limit.amount.limit);
	add("llm_usage_limit_remaining", withUnit, limit.amount.remaining);

	if (limit.window?.resetsAt !== undefined) {
		add("llm_usage_limit_resets_at_seconds", base, limit.window.resetsAt / 1000);
	}
	add("llm_usage_limit_status", base, STATUS_VALUE[limit.status ?? "unknown"]);
}
