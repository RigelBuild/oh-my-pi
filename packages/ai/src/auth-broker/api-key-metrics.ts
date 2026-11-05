import type { CredentialUsageTotal, StoredLimitObservation, UsageLimit } from "../usage";
import { resolveUsedFraction } from "../usage";
import { formatValue, renderLabels, STATUS_VALUE, type Label } from "./prometheus-metrics";
import { OBSERVED_MODEL_CLASS_PATTERN } from "./types";

export const MAX_API_KEY_SERIES = 600;

export interface ApiKeyMetricsConfig {
	readonly maxRoster: number;
	readonly providers: readonly string[];
	readonly modelClasses: readonly string[];
}

export interface ApiKeyMetricsSizes {
	readonly maxRoster: number;
	readonly providers: number;
	readonly modelClasses: number;
}

/**
 * Worst-case counters, six gauges for each configured model/window, freshness,
 * and per API-key row credit status plus its observation time.
 */
export function apiKeySeriesCeiling(sizes: ApiKeyMetricsSizes): number {
	const rosterCounterSeries = sizes.maxRoster * 8;
	const collapsedCounterSeries = (sizes.providers + 1) * 24;
	const creditStatusSeries = sizes.maxRoster * 2;
	const limitsAndFreshness = sizes.maxRoster * sizes.modelClasses * 19;
	const ceiling = rosterCounterSeries + collapsedCounterSeries + creditStatusSeries + limitsAndFreshness;
	if (ceiling > MAX_API_KEY_SERIES) {
		throw new Error(`worst-case series ceiling ${ceiling} exceeds ${MAX_API_KEY_SERIES}`);
	}
	return ceiling;
}

/** Validate config values after JSON parsing, including all source-side cardinality bounds. */
export function validateApiKeyMetricsConfig(value: unknown, source = "API-key metrics config"): ApiKeyMetricsConfig {
	if (!isPlainObject(value)) throw new Error(`${source} must be a JSON object`);
	const root = value;
	const unknown = Object.keys(root).filter(key => !["maxRoster", "providers", "modelClasses"].includes(key));
	if (unknown.length > 0) throw new Error(`${source} has unknown key(s): ${unknown.join(", ")}`);
	if (
		typeof root.maxRoster !== "number" ||
		!Number.isSafeInteger(root.maxRoster) ||
		root.maxRoster < 1 ||
		root.maxRoster > 6
	) {
		throw new Error(`${source}: "maxRoster" must be an integer from 1 through 6`);
	}
	if (!Array.isArray(root.providers)) throw new Error(`${source}: "providers" must be an array`);
	if (!Array.isArray(root.modelClasses)) throw new Error(`${source}: "modelClasses" must be an array`);
	const providers = root.providers;
	const modelClasses = root.modelClasses;
	if (providers.length > 3) throw new Error(`${source}: providers must contain at most 3 names`);
	if (modelClasses.length > 3) throw new Error(`${source}: modelClasses must contain at most 3 names`);

	const parsedProviders: string[] = [];
	for (const [index, entry] of providers.entries()) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(`${source}: providers[${index}] must be a non-empty string`);
		}
		if (entry !== entry.trim())
			throw new Error(`${source}: providers[${index}] must not have surrounding whitespace`);
		if (entry === "other")
			throw new Error(`${source}: providers[${index}] "other" is reserved for the collapse bucket`);
		parsedProviders.push(entry);
	}
	if (new Set(parsedProviders).size !== parsedProviders.length)
		throw new Error(`${source}: providers must not contain duplicates`);

	const parsedModelClasses: string[] = [];
	for (const [index, entry] of modelClasses.entries()) {
		if (typeof entry !== "string" || !OBSERVED_MODEL_CLASS_PATTERN.test(entry)) {
			throw new Error(`${source}: modelClasses[${index}] must match ${OBSERVED_MODEL_CLASS_PATTERN.source}`);
		}
		parsedModelClasses.push(entry);
	}
	if (new Set(parsedModelClasses).size !== parsedModelClasses.length) {
		throw new Error(`${source}: modelClasses must not contain duplicates`);
	}
	apiKeySeriesCeiling({
		maxRoster: root.maxRoster,
		providers: parsedProviders.length,
		modelClasses: parsedModelClasses.length,
	});
	return { maxRoster: root.maxRoster, providers: parsedProviders, modelClasses: parsedModelClasses };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Sample {
	readonly labels: readonly Label[];
	value: number;
}

interface MetricFamily {
	readonly name: string;
	readonly help: string;
	readonly type: "counter" | "gauge";
	readonly samples: Sample[];
}

const COUNTER_METRICS = [
	{
		name: "llm_gateway_tokens_total",
		help: "Observed upstream token usage by credential and token kind.",
		type: "counter",
	},
	{
		name: "llm_gateway_requests_total",
		help: "Settled upstream requests by credential and outcome.",
		type: "counter",
	},
	{
		name: "llm_gateway_estimated_cost_usd_total",
		help: "Lifetime model-priced estimated cost in USD by credential.",
		type: "counter",
	},
] as const;
const LIMIT_METRICS = [
	{ suffix: "used_fraction", help: "Fraction (0..1) of an observed API-key limit consumed." },
	{ suffix: "used", help: "Observed amount used for an API-key limit." },
	{ suffix: "max", help: "Observed maximum amount for an API-key limit." },
	{ suffix: "remaining", help: "Observed remaining amount for an API-key limit." },
	{ suffix: "resets_at_seconds", help: "Unix time (seconds) when an observed API-key limit resets." },
	{ suffix: "status", help: "Observed API-key limit status: 0 ok, 1 warning, 2 exhausted, -1 unknown." },
] as const;
const ALLOWED_LIMIT_WINDOWS = ["requests", "input-tokens", "output-tokens"] as const;
const TOKEN_KIND_BY_METRIC: Record<string, string> = {
	input: "input",
	output: "output",
	cache_read: "cache_read",
	cache_write: "cache_write",
};
const OUTCOME_BY_METRIC: Record<string, string> = { ok: "ok", error: "error", aborted: "aborted" };

/** Render bounded credential counters and selected API-key observations. */
export function renderApiKeyMetrics(
	totals: readonly CredentialUsageTotal[],
	observations: readonly StoredLimitObservation[],
	config: ApiKeyMetricsConfig,
	apiKeyCredentials: readonly {
		credentialId: number;
		provider: string;
		credentialType: "api_key" | "oauth";
		enabled?: boolean;
	}[] = [],
): string {
	const providers = new Set(config.providers);
	const modelClasses = new Set(config.modelClasses);
	const selectedCredentials: (typeof apiKeyCredentials)[number][] = [];
	for (const credential of apiKeyCredentials) {
		if (
			credential.enabled === false ||
			credential.credentialType !== "api_key" ||
			!providers.has(credential.provider)
		)
			continue;
		let index = 0;
		while (index < selectedCredentials.length) {
			const selected = selectedCredentials[index];
			if (!selected || selected.credentialId > credential.credentialId) break;
			index += 1;
		}
		if (index >= config.maxRoster) continue;
		selectedCredentials.splice(index, 0, credential);
		if (selectedCredentials.length > config.maxRoster) selectedCredentials.pop();
	}
	const current = new Map(selectedCredentials.map(credential => [credential.credentialId, credential]));
	const families: MetricFamily[] = [
		...COUNTER_METRICS.map(metric => ({ ...metric, type: "counter" as const, samples: [] })),
		...LIMIT_METRICS.map(metric => ({
			name: `llm_api_key_limit_${metric.suffix}`,
			help: metric.help,
			type: "gauge" as const,
			samples: [],
		})),
		{
			name: "llm_api_key_report_fetched_at_seconds",
			help: "Unix time (seconds) of the newest observed API-key limit report.",
			type: "gauge",
			samples: [],
		},
		{
			name: "llm_api_key_credit_exhausted",
			help: "Whether the newest API-key observation reports exhausted credit.",
			type: "gauge",
			samples: [],
		},
		{
			name: "llm_api_key_credit_observed_at_seconds",
			help: "Unix time (seconds) of the newest observation behind llm_api_key_credit_exhausted.",
			type: "gauge",
			samples: [],
		},
	];
	const byName = new Map(families.map(family => [family.name, family]));
	const seen = new Map<string, Sample>();
	const add = (name: string, labels: readonly Label[], value: number | undefined, sum = false): void => {
		if (value === undefined) return;
		const family = byName.get(name);
		if (!family) return;
		const key = `${name}\u0000${JSON.stringify(labels)}`;
		const previous = seen.get(key);
		if (previous) {
			if (sum) previous.value += value;
			else previous.value = value;
			return;
		}
		const sample = { labels, value };
		seen.set(key, sample);
		family.samples.push(sample);
	};

	// A rostered row's counters take its current provider and class, so retained
	// totals from an older provider/type spelling cannot add series past the bound.
	for (const total of totals) {
		const row = current.get(total.credentialId);
		const account = row ? `credential:${total.credentialId}` : "unknown";
		const rawProvider = row?.provider ?? total.provider;
		const provider = providers.has(rawProvider) ? rawProvider : "other";
		const rawType = row?.credentialType ?? total.credentialType;
		const credentialType = rawType === "api_key" || rawType === "oauth" ? rawType : "unknown";
		const base: readonly Label[] = [
			["provider", provider],
			["account", account],
			["credential_type", credentialType],
		];
		if (total.metric.startsWith("tokens:")) {
			const tokenKind = TOKEN_KIND_BY_METRIC[total.metric.slice("tokens:".length)];
			if (tokenKind) add("llm_gateway_tokens_total", [...base, ["token_kind", tokenKind]], total.value, true);
		} else if (total.metric.startsWith("requests:")) {
			const outcome = OUTCOME_BY_METRIC[total.metric.slice("requests:".length)];
			if (outcome) add("llm_gateway_requests_total", [...base, ["outcome", outcome]], total.value, true);
		} else if (total.metric === "estimated_cost_usd") {
			add("llm_gateway_estimated_cost_usd_total", base, total.value, true);
		}
	}
	const newestLimits = new Map<
		string,
		{ credentialId: number; provider: string; modelClass: string; at: number; limit: UsageLimit }
	>();
	const newestFetched = new Map<string, { provider: string; account: string; modelClass: string; at: number }>();
	const newestCredit = new Map<number, StoredLimitObservation>();
	for (const observation of observations) {
		if (!current.has(observation.credentialId)) continue;
		const provider = providers.has(observation.provider) ? observation.provider : "other";
		if (observation.credentialType === "api_key") {
			const prior = newestCredit.get(observation.credentialId);
			if (!prior || observation.at >= prior.at) newestCredit.set(observation.credentialId, observation);
		}
		if (observation.credentialType !== "api_key" || observation.provider !== "anthropic") continue;
		const modelClass = observation.modelClass;
		if (!modelClass || !modelClasses.has(modelClass)) continue;
		const account = `credential:${observation.credentialId}`;
		let accepted = false;
		for (const limit of observation.limits) {
			if (!ALLOWED_LIMIT_WINDOWS.some(window => limit.id === `anthropic:api:${modelClass}:${window}`)) continue;
			accepted = true;
			const limitKey = JSON.stringify([observation.credentialId, provider, modelClass, limit.id]);
			const prior = newestLimits.get(limitKey);
			if (!prior || observation.at >= prior.at)
				newestLimits.set(limitKey, {
					credentialId: observation.credentialId,
					provider,
					modelClass,
					at: observation.at,
					limit,
				});
		}
		// Freshness dates the numeric limits, so an error-only observation does not advance it.
		if (!accepted) continue;
		const reportKey = JSON.stringify([provider, account, modelClass]);
		const priorFetchedAt = newestFetched.get(reportKey);
		if (!priorFetchedAt || observation.at > priorFetchedAt.at)
			newestFetched.set(reportKey, { provider, account, modelClass, at: observation.at });
	}

	for (const { credentialId, provider, modelClass, limit } of newestLimits.values()) {
		const labels: readonly Label[] = [
			["provider", provider],
			["account", `credential:${credentialId}`],
			["model_class", modelClass],
			["limit_id", limit.id],
		];
		add("llm_api_key_limit_used_fraction", labels, resolveUsedFraction(limit));
		add("llm_api_key_limit_used", labels, limit.amount.used);
		add("llm_api_key_limit_max", labels, limit.amount.limit);
		add("llm_api_key_limit_remaining", labels, limit.amount.remaining);
		add(
			"llm_api_key_limit_resets_at_seconds",
			labels,
			limit.window?.resetsAt === undefined ? undefined : limit.window.resetsAt / 1000,
		);
		add("llm_api_key_limit_status", labels, STATUS_VALUE[limit.status ?? "unknown"]);
	}
	for (const { provider, account, modelClass, at } of newestFetched.values()) {
		add(
			"llm_api_key_report_fetched_at_seconds",
			[
				["provider", provider],
				["account", account],
				["model_class", modelClass],
			],
			at / 1000,
		);
	}

	const apiKeyRows = new Map<number, string>();
	for (const credential of selectedCredentials) {
		apiKeyRows.set(credential.credentialId, providers.has(credential.provider) ? credential.provider : "other");
	}
	for (const [credentialId, observation] of newestCredit) {
		if (!apiKeyRows.has(credentialId)) continue;
		apiKeyRows.set(credentialId, providers.has(observation.provider) ? observation.provider : "other");
	}
	// Credit time is its own gauge: an explicit sample timestamp older than the
	// ingest out-of-order window would make the scrape drop the series.
	for (const [credentialId, provider] of apiKeyRows) {
		const observation = newestCredit.get(credentialId);
		if (!observation) continue;
		const labels: readonly Label[] = [
			["provider", provider],
			["account", `credential:${credentialId}`],
		];
		add("llm_api_key_credit_exhausted", labels, observation.error === "credit_exhausted" ? 1 : 0);
		add("llm_api_key_credit_observed_at_seconds", labels, observation.at / 1000);
	}

	const lines: string[] = [];
	for (const family of families) {
		if (family.samples.length === 0) continue;
		lines.push(`# HELP ${family.name} ${family.help}`);
		lines.push(`# TYPE ${family.name} ${family.type}`);
		for (const sample of family.samples) {
			lines.push(`${family.name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
