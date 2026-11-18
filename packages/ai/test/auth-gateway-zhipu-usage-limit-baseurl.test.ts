import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@oh-my-pi/pi-ai";
import { buildGatewayApiKeyResolver } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

const PROVIDER = "cc-switch-zhipu-glm";
const CODING_PLAN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const RESET_WAIT_MS = 82 * 60_000;
const HOUR_MS = 60 * 60 * 1000;

const stores: AuthStorage[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const storage of stores.splice(0)) storage.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("auth-gateway usage limit on a custom Zhipu Coding Plan endpoint", () => {
	it("blocks the credential until the Beijing reset, not eight hours later", async () => {
		registerMockApi();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gw-zhipu-baseurl-"));
		directories.push(directory);
		const store = await SqliteAuthCredentialStore.open(path.join(directory, "auth.db"));
		const storage = new AuthStorage(store);
		stores.push(storage);
		await storage.credentials.set(PROVIDER, [{ type: "api_key", key: "zhipu-test-key" }]);
		const sessionId = "gateway-zhipu-baseurl";
		const initialKey = await storage.keys.getWithCredential(PROVIDER, sessionId);
		if (!initialKey) throw new Error("expected initial gateway credential");

		// The reset is a naive Beijing wall stamp ~82 min out; read as UTC it adds ~8h.
		const resetStamp = new Date(Date.now() + RESET_WAIT_MS + 8 * HOUR_MS)
			.toISOString()
			.slice(0, 19)
			.replace("T", " ");
		const limitMessage = `429 已达到 5 小时的使用上限，您的限额将在 ${resetStamp} 重置. (type=1308)`;

		const model = createMockModel({
			provider: PROVIDER,
			id: "glm-coding",
			baseUrl: CODING_PLAN_BASE_URL,
		}).model;
		const resolver = buildGatewayApiKeyResolver(
			{ storage },
			model,
			sessionId,
			initialKey,
			new AbortController().signal,
			"chat",
			"peer",
			undefined,
			// Decline the account-local recovery so the call reaches markReached.
			async () => false,
		);

		const blockedBefore = Date.now();
		let attempt = 0;
		await withAuth(resolver, async () => {
			attempt += 1;
			if (attempt === 1) throw new ProviderHttpError(limitMessage, 429, {});
			return "ok";
		}).catch(() => undefined);
		const blockedAfter = Date.now();

		const rows = store.listAuthCredentials(PROVIDER);
		const blocks = store.listCredentialBlocks(rows.map(row => row.id));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(blockedBefore + RESET_WAIT_MS - 10_000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(blockedAfter + RESET_WAIT_MS + 10_000);
	});
});
