import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadApiKeyLimitModelClasses } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";

describe("loadApiKeyLimitModelClasses", () => {
	const env = "OMP_AUTH_GATEWAY_API_KEY_LIMIT_MODEL_CLASSES";
	let priorEnv: string | undefined;
	let dir = "";

	beforeEach(async () => {
		priorEnv = process.env[env];
		delete process.env[env];
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-limit-classes-"));
	});

	afterEach(async () => {
		if (priorEnv === undefined) delete process.env[env];
		else process.env[env] = priorEnv;
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function write(content: string): Promise<string> {
		const file = path.join(dir, "classes.json");
		await Bun.write(file, content);
		return file;
	}

	it("loads the map from the flag, falls back to the env var, and is absent when neither is set", async () => {
		const map = { "claude-opus-5-5": "opus-5.5", "claude-opus-4-1": "opus-4.x" };
		const file = await write(JSON.stringify(map));
		expect(await loadApiKeyLimitModelClasses(undefined)).toBeUndefined();
		expect(await loadApiKeyLimitModelClasses(file)).toEqual(map);
		process.env[env] = file;
		expect(await loadApiKeyLimitModelClasses(undefined)).toEqual(map);
		const flagFile = path.join(dir, "flag.json");
		await Bun.write(flagFile, JSON.stringify({ "claude-sonnet-4-5": "sonnet-4" }));
		expect(await loadApiKeyLimitModelClasses(flagFile)).toEqual({ "claude-sonnet-4-5": "sonnet-4" });
	});

	it("refuses a file that would boot the gateway half-configured", async () => {
		await expect(loadApiKeyLimitModelClasses(await write("{ nope"))).rejects.toThrow(/not valid JSON/);
		await expect(loadApiKeyLimitModelClasses(await write("[]"))).rejects.toThrow(/JSON object/);
		await expect(loadApiKeyLimitModelClasses(await write('{"m": 1}'))).rejects.toThrow(/must map to a string/);
		await expect(loadApiKeyLimitModelClasses(await write('{"m": "Opus 5"}'))).rejects.toThrow(/must match/);
		await expect(
			loadApiKeyLimitModelClasses(await write('{"a": "r1", "b": "r2", "c": "r3", "d": "r4"}')),
		).rejects.toThrow(/at most 3/);
	});
});
