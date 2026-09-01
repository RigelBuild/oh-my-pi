import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubscriptionsConfig, parseSubscriptionsConfig } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

const FILE = "test.json";

describe("parseSubscriptionsConfig", () => {
	it("resolves accounts and plans from a valid config", () => {
		const raw = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", plan: "max", renewsAt: "2026-08-26" },
			},
			plans: {
				"anthropic:max": { capacityWeight: 2, monthlyPriceUsd: 200 },
			},
		});
		const lookup = parseSubscriptionsConfig(raw, FILE);
		const entry = lookup.lookup("anthropic", "acct-1", "");
		expect(entry).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(lookup.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 2, monthlyPriceUsd: 200 }]);
	});

	it("pins renewsAt to UTC-midnight epoch seconds (no TZ drift)", () => {
		const raw = JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26" } } });
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("p", "a", "")?.renewsAtSeconds).toBe(1787702400);
	});

	it("accepts empty/absent maps without throwing", () => {
		const lookup = parseSubscriptionsConfig("{}", FILE);
		expect(lookup.lookup("p", "a", "")).toBeUndefined();
		expect(lookup.plans).toEqual([]);
	});

	it("parses an entry that omits plan entirely (renewal-only / provider-derived)", () => {
		const raw = JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26" } } });
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("p", "a", "")).toEqual({ plan: undefined, renewsAtSeconds: 1787702400 });
	});

	it("scopes account entries by org and falls back to an org-less entry", () => {
		const raw = JSON.stringify({
			accounts: {
				"acct-1": { provider: "anthropic", org: "org-team", plan: "team" },
				"acct-1 personal": { provider: "anthropic", org: "org-personal", plan: "max" },
				"acct-2": { provider: "anthropic", plan: "pro" },
			},
		});
		const lookup = parseSubscriptionsConfig(raw, FILE);
		// Distinct org keys resolve to their own entry.
		expect(lookup.lookup("anthropic", "acct-1", "org-team")).toEqual({ plan: "team", renewsAtSeconds: undefined });
		expect(lookup.lookup("anthropic", "acct-1 personal", "org-personal")).toEqual({
			plan: "max",
			renewsAtSeconds: undefined,
		});
		// An org-less config entry resolves for any org of that account.
		expect(lookup.lookup("anthropic", "acct-2", "org-x")).toEqual({ plan: "pro", renewsAtSeconds: undefined });
		expect(lookup.lookup("anthropic", "acct-2", "")).toEqual({ plan: "pro", renewsAtSeconds: undefined });
		// An org-scoped entry does not answer a mismatched org unless a bare
		// fallback exists.
		expect(lookup.lookup("anthropic", "acct-1", "org-personal")).toBeUndefined();
	});

	it("resolves the SAME account id in two orgs via the nested orgs map", () => {
		// Two orgs for one account id cannot be two top-level `accounts` keys —
		// JSON.parse keeps only the last property of a duplicated key. The nested
		// `orgs` map lets a single account id carry an independent plan/renewal per
		// org; a regression collapses both orgs onto one plan (or drops one).
		const raw = JSON.stringify({
			accounts: {
				"acct-1": {
					provider: "anthropic",
					org: "org-team",
					plan: "team",
					renewsAt: "2026-08-26",
					orgs: {
						"org-personal": { plan: "max", renewsAt: "2026-09-15" },
					},
				},
			},
		});
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("anthropic", "acct-1", "org-team")).toEqual({ plan: "team", renewsAtSeconds: 1787702400 });
		expect(lookup.lookup("anthropic", "acct-1", "org-personal")).toEqual({
			plan: "max",
			renewsAtSeconds: 1789430400,
		});
		// Neither org's entry leaks to a third, unconfigured org (no bare fallback).
		expect(lookup.lookup("anthropic", "acct-1", "org-other")).toBeUndefined();
	});

	const throwCases: Array<[string, string]> = [
		["non-JSON string", "not json"],
		["JSON non-object root (number)", "3"],
		["JSON array root (accounts/plans silently absent)", "[]"],
		["account entry not an object", JSON.stringify({ accounts: { a: 5 } })],
		["provider missing", JSON.stringify({ accounts: { a: {} } })],
		["provider not a string", JSON.stringify({ accounts: { a: { provider: 1 } } })],
		["provider empty string", JSON.stringify({ accounts: { a: { provider: "" } } })],
		["account key empty string", JSON.stringify({ accounts: { "": { provider: "p" } } })],
		[
			"org not a string (number coerced to empty scope)",
			JSON.stringify({ accounts: { a: { provider: "p", org: 42 } } }),
		],
		["orgs map not an object", JSON.stringify({ accounts: { a: { provider: "p", orgs: 5 } } })],
		["orgs entry not an object", JSON.stringify({ accounts: { a: { provider: "p", orgs: { x: 5 } } } })],
		[
			"org scope declared twice (top-level org + orgs key)",
			JSON.stringify({ accounts: { a: { provider: "p", org: "team", orgs: { team: { plan: "x" } } } } }),
		],
		[
			"nested org plan not a string",
			JSON.stringify({ accounts: { a: { provider: "p", orgs: { x: { plan: 1 } } } } }),
		],
		["plan not a string", JSON.stringify({ accounts: { a: { provider: "p", plan: 1 } } })],
		["renewsAt not a string", JSON.stringify({ accounts: { a: { provider: "p", renewsAt: 1 } } })],
		[
			"renewsAt wrong format (single digits)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-8-6" } } }),
		],
		[
			"renewsAt wrong format (slashes)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "08/26/2026" } } }),
		],
		[
			"renewsAt wrong format (datetime)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26T00:00:00" } } }),
		],
		["renewsAt unparseable", JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-13-99" } } })],
		["plan key with no colon", JSON.stringify({ plans: { max: { capacityWeight: 1, monthlyPriceUsd: 1 } } })],
		["plan key leading colon", JSON.stringify({ plans: { ":max": { capacityWeight: 1, monthlyPriceUsd: 1 } } })],
		[
			"plan key trailing colon",
			JSON.stringify({ plans: { "anthropic:": { capacityWeight: 1, monthlyPriceUsd: 1 } } }),
		],
		[
			"capacityWeight non-number",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: "1", monthlyPriceUsd: 1 } } }),
		],
		[
			"monthlyPriceUsd non-number",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: 1, monthlyPriceUsd: "1" } } }),
		],
		["accounts map is null", JSON.stringify({ accounts: null })],
		["accounts map is an array", JSON.stringify({ accounts: [] })],
		["accounts map is a number", JSON.stringify({ accounts: 3 })],
		["plans map is null", JSON.stringify({ plans: null })],
		["plans map is an array", JSON.stringify({ plans: [] })],
		["plans map is a number", JSON.stringify({ plans: 3 })],
		[
			"renewsAt normalized-invalid (2026-02-29)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-02-29" } } }),
		],
		[
			"renewsAt normalized-invalid (2026-02-31)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-02-31" } } }),
		],
		[
			"renewsAt normalized-invalid (2026-13-01)",
			JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-13-01" } } }),
		],
		[
			"plan keys collapse to one canonical identity",
			JSON.stringify({
				plans: {
					"anthropic:Max Plan": { capacityWeight: 1, monthlyPriceUsd: 1 },
					"anthropic:max-plan": { capacityWeight: 2, monthlyPriceUsd: 2 },
				},
			}),
		],
		["account plan empty string", JSON.stringify({ accounts: { a: { provider: "p", plan: "" } } })],
		["account plan whitespace-only", JSON.stringify({ accounts: { a: { provider: "p", plan: "   " } } })],
		[
			"nested org plan empty string",
			JSON.stringify({ accounts: { a: { provider: "p", orgs: { x: { plan: "" } } } } }),
		],
		[
			"plan key canonically empty (trailing chatgpt_)",
			JSON.stringify({ plans: { "anthropic:chatgpt_": { capacityWeight: 1, monthlyPriceUsd: 1 } } }),
		],
		[
			"plan key canonically empty (whitespace suffix)",
			JSON.stringify({ plans: { "anthropic:   ": { capacityWeight: 1, monthlyPriceUsd: 1 } } }),
		],
		[
			"capacityWeight negative",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: -1, monthlyPriceUsd: 1 } } }),
		],
		[
			"capacityWeight non-finite (Infinity)",
			// JSON has no NaN/Infinity literal; `1e999` overflows to Infinity on
			// JSON.parse, which is a `number` (passing the type check) but not
			// finite, so the range guard is what must reject it.
			'{"plans":{"anthropic:max":{"capacityWeight":1e999,"monthlyPriceUsd":1}}}',
		],
		[
			"monthlyPriceUsd negative",
			JSON.stringify({ plans: { "anthropic:max": { capacityWeight: 1, monthlyPriceUsd: -0.01 } } }),
		],
		[
			"monthlyPriceUsd non-finite (Infinity)",
			'{"plans":{"anthropic:max":{"capacityWeight":1,"monthlyPriceUsd":1e999}}}',
		],
	];

	for (const [name, raw] of throwCases) {
		it(`throws on ${name}`, () => {
			expect(() => parseSubscriptionsConfig(raw, FILE)).toThrow();
		});
	}
});

describe("loadSubscriptionsConfig", () => {
	const tempDirs: string[] = [];
	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reads and parses a valid config file (via Bun.file)", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authbroker-subs-"));
		tempDirs.push(dir);
		const file = path.join(dir, "subs.json");
		await Bun.write(
			file,
			JSON.stringify({
				accounts: { "acct-1": { provider: "anthropic", plan: "max", renewsAt: "2026-08-26" } },
				plans: { "anthropic:max": { capacityWeight: 2, monthlyPriceUsd: 200 } },
			}),
		);
		const lookup = await loadSubscriptionsConfig(file);
		expect(lookup?.lookup("anthropic", "acct-1", "")).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(lookup?.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 2, monthlyPriceUsd: 200 }]);
	});

	it("returns undefined when no path is configured", async () => {
		expect(await loadSubscriptionsConfig(undefined)).toBeUndefined();
	});
});
