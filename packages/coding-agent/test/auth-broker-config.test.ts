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
		const entry = lookup.lookup("anthropic", "acct-1");
		expect(entry).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(lookup.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 2, monthlyPriceUsd: 200 }]);
	});

	it("pins renewsAt to UTC-midnight epoch seconds (no TZ drift)", () => {
		const raw = JSON.stringify({ accounts: { a: { provider: "p", renewsAt: "2026-08-26" } } });
		const lookup = parseSubscriptionsConfig(raw, FILE);
		expect(lookup.lookup("p", "a")?.renewsAtSeconds).toBe(1787702400);
	});

	it("accepts empty/absent maps without throwing", () => {
		const lookup = parseSubscriptionsConfig("{}", FILE);
		expect(lookup.lookup("p", "a")).toBeUndefined();
		expect(lookup.plans).toEqual([]);
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
		expect(lookup?.lookup("anthropic", "acct-1")).toEqual({ plan: "max", renewsAtSeconds: 1787702400 });
		expect(lookup?.plans).toEqual([{ provider: "anthropic", plan: "max", capacityWeight: 2, monthlyPriceUsd: 200 }]);
	});

	it("returns undefined when no path is configured", async () => {
		expect(await loadSubscriptionsConfig(undefined)).toBeUndefined();
	});
});
