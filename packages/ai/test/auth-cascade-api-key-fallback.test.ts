import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "anthropic";
const BLOCK_UNTIL = Date.now() + 60 * 60_000;

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
	};
}

describe("OAuth fallback to stored API keys", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-cascade-api-key-fallback-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage?.close();
		store?.close();
		storage = undefined;
		store = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	async function block(providerKey: string, credentialIds: readonly number[]) {
		if (!store) throw new Error("test setup failed");
		for (const credentialId of credentialIds) {
			store.upsertCredentialBlock({
				credentialId,
				providerKey,
				blockScope: "",
				blockedUntilMs: BLOCK_UNTIL,
			});
		}
	}

	test("uses an unblocked stored API key when every OAuth credential is blocked", async () => {
		if (!store || !storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [
			oauthCredential("first"),
			oauthCredential("second"),
			{ type: "api_key", key: "stored-key" },
		]);
		const rows = store.listAuthCredentials(PROVIDER);
		const oauthRow = rows.find(row => row.credential.type === "oauth");
		if (!oauthRow) throw new Error("OAuth credential missing");
		expect(storage.sessions.pin(PROVIDER, "session", oauthRow.id)).toBe(true);
		await block(
			`${PROVIDER}:oauth`,
			rows.filter(row => row.credential.type === "oauth").map(row => row.id),
		);

		expect(await storage.keys.get(PROVIDER, "session")).toBe("stored-key");
		expect(storage.oauth.identity(PROVIDER, "session")).toBeUndefined();
	});

	test("keeps unblocked OAuth ahead of a stored API key", async () => {
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("available"), { type: "api_key", key: "stored-key" }]);

		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-available");
	});

	test("tries unblocked OAuth outside preferred accounts before spending a stored API key", async () => {
		if (!store || !storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [
			oauthCredential("preferred"),
			oauthCredential("available"),
			{ type: "api_key", key: "stored-key" },
		]);
		const preferred = store
			.listAuthCredentials(PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-preferred");
		if (!preferred) throw new Error("preferred credential missing");
		await block(`${PROVIDER}:oauth`, [preferred.id]);
		expect(await storage.keys.get(PROVIDER, "session", { accountIds: ["account-preferred"] })).toBe(
			"access-available",
		);
	});

	test("returns blocked OAuth as a last resort when no stored API key exists", async () => {
		if (!store || !storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("blocked")]);
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("credential missing");
		await block(`${PROVIDER}:oauth`, [row.id]);

		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-blocked");
	});

	test("returns blocked OAuth when the stored API key is also blocked", async () => {
		if (!store || !storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("blocked"), { type: "api_key", key: "stored-key" }]);
		const rows = store.listAuthCredentials(PROVIDER);
		const oauthRow = rows.find(row => row.credential.type === "oauth");
		const apiKeyRow = rows.find(row => row.credential.type === "api_key");
		if (!oauthRow || !apiKeyRow) throw new Error("credentials missing");
		await block(`${PROVIDER}:oauth`, [oauthRow.id]);
		await block(`${PROVIDER}:api_key`, [apiKeyRow.id]);

		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-blocked");
	});

	test("reports an unblocked stored API key usable past blocked OAuth, then false when both are blocked", async () => {
		if (!store || !storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("blocked"), { type: "api_key", key: "stored-key" }]);
		const rows = store.listAuthCredentials(PROVIDER);
		const oauthRow = rows.find(row => row.credential.type === "oauth");
		const apiKeyRow = rows.find(row => row.credential.type === "api_key");
		if (!oauthRow || !apiKeyRow) throw new Error("credentials missing");
		await block(`${PROVIDER}:oauth`, [oauthRow.id]);

		expect(storage.keys.hasUsable(PROVIDER)).toBe(true);
		await block(`${PROVIDER}:api_key`, [apiKeyRow.id]);
		expect(storage.keys.hasUsable(PROVIDER)).toBe(false);
	});
});
