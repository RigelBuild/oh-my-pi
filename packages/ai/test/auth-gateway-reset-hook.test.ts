import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@oh-my-pi/pi-ai";
import { buildGatewayApiKeyResolver } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

const stores: AuthStorage[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const storage of stores.splice(0)) storage.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function setup(
	withSibling: boolean,
	onUsageLimit: (ctx: {
		provider: string;
		credentialId: number;
		modelId: string;
		signal: AbortSignal;
	}) => Promise<boolean>,
) {
	registerMockApi();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gw-reset-hook-"));
	directories.push(directory);
	const storage = await AuthStorage.create(path.join(directory, "auth.db"));
	stores.push(storage);
	await storage.credentials.set("mock", [{ type: "api_key", key: "quota-key" }]);
	const sessionId = "gateway-reset-retry";
	const initialKey = await storage.keys.getWithCredential("mock", sessionId);
	if (!initialKey) throw new Error("expected initial gateway credential");
	if (withSibling) {
		await storage.credentials.set("mock", [
			{ type: "api_key", key: "quota-key" },
			{ type: "api_key", key: "healthy-key" },
		]);
	}
	const model = createMockModel({ provider: "mock", id: "gateway-reset-model" }).model;
	const resolver = buildGatewayApiKeyResolver(
		storage,
		model,
		sessionId,
		initialKey,
		new AbortController().signal,
		"chat",
		"peer",
		undefined,
		onUsageLimit,
	);
	return { storage, resolver, initialKey };
}

describe("auth-gateway usage-limit reset hook", () => {
	it("retries a restored credential's same bearer through withAuth without recording a block", async () => {
		const hook = spyOn(
			{
				run: async (_ctx: { provider: string; credentialId: number; modelId: string; signal: AbortSignal }) => true,
			},
			"run",
		);
		const { storage, resolver, initialKey } = await setup(false, ctx => hook(ctx));
		const markSpy = spyOn(storage.limits, "markReached");
		const attemptedKeys: string[] = [];
		let attempt = 0;
		const result = await withAuth(resolver, async key => {
			attemptedKeys.push(key);
			attempt += 1;
			if (attempt === 1)
				throw new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" });
			return `ok:${key}`;
		});
		expect(result).toBe(`ok:${initialKey.apiKey}`);
		expect(attemptedKeys).toEqual([initialKey.apiKey, initialKey.apiKey]);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(markSpy).not.toHaveBeenCalled();
	});

	it("rotates to the sibling when the reset hook declines", async () => {
		const hook = spyOn(
			{
				run: async (_ctx: { provider: string; credentialId: number; modelId: string; signal: AbortSignal }) =>
					false,
			},
			"run",
		);
		const { storage, resolver, initialKey } = await setup(true, ctx => hook(ctx));
		const markSpy = spyOn(storage.limits, "markReached");
		const attemptedKeys: string[] = [];
		const result = await withAuth(resolver, async key => {
			attemptedKeys.push(key);
			if (key === initialKey.apiKey)
				throw new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" });
			return `ok:${key}`;
		});
		expect(result).not.toBe(`ok:${initialKey.apiKey}`);
		expect(attemptedKeys).toHaveLength(2);
		expect(attemptedKeys[0]).toBe(initialKey.apiKey);
		expect(attemptedKeys[1]).not.toBe(initialKey.apiKey);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(markSpy).toHaveBeenCalledTimes(1);
	});
});
