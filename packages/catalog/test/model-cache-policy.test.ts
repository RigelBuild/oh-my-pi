import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	assessModelCache,
	assessModelCacheVerdict,
	type ModelManagerOptions,
	modelCacheNeedsFetch,
	resolveModelManagerStaticCatalog,
	resolveProviderModels,
} from "@oh-my-pi/pi-catalog/model-manager";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const PROVIDER = "cache-policy-parity";
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const WRITTEN_AT = 1_000_000;

function spec(id: string, headers?: Record<string, string>): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(headers ? { headers } : {}),
	};
}

interface Scenario {
	name: string;
	options?: Partial<ModelManagerOptions<"openai-completions">>;
	cached: Model<"openai-completions">[];
	authoritative: boolean;
	fingerprint: "current" | "stale";
	ageMs: number;
	expectFetch: boolean;
}

const plain = buildModel(spec("plain"));
const migrated = buildModel(spec("migrated"));
const headerOnly = buildModel(spec("header-only", { "X-Key": "secret" }));

const scenarios: Scenario[] = [
	{
		name: "fresh authoritative",
		cached: [plain],
		authoritative: true,
		fingerprint: "current",
		ageMs: 0,
		expectFetch: false,
	},
	{
		name: "expired authoritative",
		cached: [plain],
		authoritative: true,
		fingerprint: "current",
		ageMs: TTL_MS + 1,
		expectFetch: true,
	},
	{
		name: "non-authoritative inside backoff",
		cached: [plain],
		authoritative: false,
		fingerprint: "current",
		ageMs: RETRY_MS - 1,
		expectFetch: false,
	},
	{
		name: "non-authoritative after backoff",
		cached: [plain],
		authoritative: false,
		fingerprint: "current",
		ageMs: RETRY_MS,
		expectFetch: true,
	},
	{
		name: "unrestorable headers",
		cached: [headerOnly],
		authoritative: true,
		fingerprint: "current",
		ageMs: 0,
		expectFetch: true,
	},
	{
		name: "headers restored from local config",
		options: { restoreCachedHeaders: () => ({ headers: { "X-Key": "configured" } }) },
		cached: [headerOnly],
		authoritative: true,
		fingerprint: "current",
		ageMs: 0,
		expectFetch: false,
	},
	{
		name: "migration id under stale fingerprint",
		options: { dropCachedModelIdsOnStaticMismatch: ["migrated"] },
		cached: [plain, migrated],
		authoritative: true,
		fingerprint: "stale",
		ageMs: 0,
		expectFetch: true,
	},
	{
		name: "migration id under current fingerprint",
		options: { dropCachedModelIdsOnStaticMismatch: ["migrated"] },
		cached: [plain, migrated],
		authoritative: true,
		fingerprint: "current",
		ageMs: 0,
		expectFetch: false,
	},
	{
		name: "authoritative discovery under stale fingerprint",
		options: { dynamicModelsAuthoritative: true },
		cached: [plain],
		authoritative: true,
		fingerprint: "stale",
		ageMs: 0,
		expectFetch: true,
	},
];

describe("assessModelCache and assessModelCacheVerdict parity with resolveProviderModels", () => {
	for (const scenario of scenarios) {
		it(`agrees on fetch for ${scenario.name}`, async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-cache-policy-"));
			const dbPath = path.join(tempDir, "models.db");
			const nowMs = WRITTEN_AT + scenario.ageMs;
			let fetches = 0;
			const options: ModelManagerOptions<"openai-completions"> = {
				providerId: PROVIDER,
				staticModels: [],
				cacheDbPath: dbPath,
				cacheTtlMs: TTL_MS,
				now: () => nowMs,
				fetchDynamicModels: async () => {
					fetches++;
					return null;
				},
				...scenario.options,
			};
			try {
				const staticCatalog = resolveModelManagerStaticCatalog(options);
				const fingerprint = scenario.fingerprint === "current" ? staticCatalog.fingerprint : "stale-fingerprint";
				writeModelCache(PROVIDER, WRITTEN_AT, scenario.cached, scenario.authoritative, fingerprint, dbPath);
				const cache = readModelCache<"openai-completions">(PROVIDER, TTL_MS, () => nowMs, dbPath);
				expect(cache).not.toBeNull();

				const assessment = assessModelCache(options, staticCatalog, cache, nowMs);
				const verdict = modelCacheNeedsFetch(assessment, "online-if-uncached");
				const verdictOnly = assessModelCacheVerdict(options, staticCatalog, cache, nowMs);
				const resolved = await resolveProviderModels(options, "online-if-uncached");

				expect(verdict).toBe(scenario.expectFetch);
				expect(modelCacheNeedsFetch(verdictOnly, "online-if-uncached")).toBe(verdict);
				expect(verdictOnly.hasUsableFreshCache).toBe(assessment.hasUsableFreshCache);
				expect(verdictOnly.hasUnresolvedHeaders).toBe(assessment.hasUnresolvedHeaders);
				expect(fetches > 0).toBe(verdict);
				if (scenario.name === "headers restored from local config") {
					expect(resolved.models.find(model => model.id === "header-only")?.headers).toEqual({
						"X-Key": "configured",
					});
				}
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});
	}
});
