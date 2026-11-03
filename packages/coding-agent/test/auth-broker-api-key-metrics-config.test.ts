import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	apiKeySeriesCeiling,
	MAX_API_KEY_SERIES,
	validateApiKeyMetricsConfig,
} from "@oh-my-pi/pi-ai/auth-broker/api-key-metrics";
import { loadApiKeyMetricsConfig } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

const FILE = "api-key-metrics.json";
const valid = {
	roster: [1, 2, 3, 4, 5, 6],
	providers: ["anthropic", "openai", "google"],
	modelClasses: ["opus-5.5", "opus-4.x", "sonnet-4"],
};
describe("API-key metrics config", () => {
	it("enforces the formula ceiling and accepts the maximum configured dimensions", () => {
		expect(apiKeySeriesCeiling({ roster: 6, providers: 3, modelClasses: 3 })).toBe(498);
		expect(() => apiKeySeriesCeiling({ roster: 20, providers: 20, modelClasses: 20 })).toThrow(
			new RegExp(`exceeds ${MAX_API_KEY_SERIES}`),
		);
		expect(validateApiKeyMetricsConfig(valid)).toEqual(valid);
	});

	it("rejects each configured dimension above its bound", () => {
		expect(() => validateApiKeyMetricsConfig({ ...valid, roster: [1, 2, 3, 4, 5, 6, 7] })).toThrow(
			/roster.*at most 6/,
		);
		expect(() => validateApiKeyMetricsConfig({ ...valid, providers: ["a", "b", "c", "d"] })).toThrow(
			/providers.*at most 3/,
		);
		expect(() => validateApiKeyMetricsConfig({ ...valid, modelClasses: ["a", "b", "c", "d"] })).toThrow(
			/modelClasses.*at most 3/,
		);
	});

	it("rejects invalid model classes, duplicates, and malformed shapes", () => {
		expect(() => validateApiKeyMetricsConfig({ ...valid, modelClasses: ["Opus 5.5"] })).toThrow(
			/modelClasses.*match/,
		);
		expect(() => validateApiKeyMetricsConfig({ ...valid, roster: [1, 1] })).toThrow(/roster.*duplicates/);
		expect(() => validateApiKeyMetricsConfig({ ...valid, providers: ["anthropic", "anthropic"] })).toThrow(
			/providers.*duplicates/,
		);
		expect(() => validateApiKeyMetricsConfig({ ...valid, modelClasses: ["opus-5.5", "opus-5.5"] })).toThrow(
			/modelClasses.*duplicates/,
		);
		expect(() => validateApiKeyMetricsConfig({ roster: "1", providers: [], modelClasses: [] })).toThrow(
			/roster.*array/,
		);
		expect(() => validateApiKeyMetricsConfig({ ...valid, extra: true })).toThrow(/unknown key/);
		expect(() => validateApiKeyMetricsConfig({ ...valid, providers: ["anthropic "] })).toThrow(
			/surrounding whitespace/,
		);
	});
});

describe("loadApiKeyMetricsConfig", () => {
	const tempDirs: string[] = [];
	const env = "OMP_AUTH_BROKER_API_KEY_METRICS";
	let priorEnv: string | undefined;

	afterEach(async () => {
		if (priorEnv === undefined) delete process.env[env];
		else process.env[env] = priorEnv;
		priorEnv = undefined;
		for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	it("loads config from a path and environment variable, and skips it while metrics are off", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authbroker-api-key-metrics-"));
		tempDirs.push(dir);
		const file = path.join(dir, FILE);
		await Bun.write(file, JSON.stringify({ roster: [7], providers: ["anthropic"], modelClasses: ["opus-5.5"] }));
		expect(await loadApiKeyMetricsConfig(file, true)).toEqual({
			roster: [7],
			providers: ["anthropic"],
			modelClasses: ["opus-5.5"],
		});
		priorEnv = process.env[env];
		process.env[env] = file;
		expect(await loadApiKeyMetricsConfig(undefined, true)).toEqual({
			roster: [7],
			providers: ["anthropic"],
			modelClasses: ["opus-5.5"],
		});
		await Bun.write(file, "{ invalid");
		expect(await loadApiKeyMetricsConfig(file, false)).toBeUndefined();
		await expect(loadApiKeyMetricsConfig(file, true)).rejects.toThrow(/not valid JSON/);
	});
});
