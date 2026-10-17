import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { CredentialRankingStrategy } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

// Unknown to the env/OAuth registries, so only stored rows can authenticate it.
const SCOPED = "has-usable-scoped";
const PLAIN = "has-usable-plain";
const HOUR_MS = 60 * 60 * 1000;
const modelScopedStrategy: CredentialRankingStrategy = {
	blockScope: context => (context?.modelId ? `model:${context.modelId}` : undefined),
	blockScopes: context => [context?.modelId ? `model:${context.modelId}` : "model", "shared"],
	findWindowLimits: () => ({}),
	windowDefaults: { primaryMs: HOUR_MS, secondaryMs: 24 * HOUR_MS },
};

function oauth(suffix: string, overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + HOUR_MS,
		accountId: `account-${suffix}`,
		...overrides,
	};
}

describe("AuthStorage.keys.hasUsable", () => {
	const opened: Array<{ dir: string; store: SqliteAuthCredentialStore; storage: AuthStorage }> = [];
	let resolverCalls = 0;

	async function open(): Promise<{ dbPath: string; store: SqliteAuthCredentialStore; storage: AuthStorage }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-has-usable-"));
		const dbPath = path.join(dir, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, {
			rankingStrategyResolver: provider => (provider === SCOPED ? modelScopedStrategy : undefined),
			async configValueResolver(config) {
				resolverCalls += 1;
				return config;
			},
		});
		opened.push({ dir, store, storage });
		return { dbPath, store, storage };
	}

	function idsOf(store: SqliteAuthCredentialStore, provider: string): number[] {
		return store.listAuthCredentials(provider).map(row => row.id);
	}

	function blockRowCount(dbPath: string, credentialId: number): number {
		const db = new Database(dbPath, { readonly: true });
		try {
			return (
				db
					.query<{ count: number }, [number]>(
						"SELECT COUNT(*) AS count FROM auth_credential_blocks WHERE credential_id = ?",
					)
					.get(credentialId)?.count ?? 0
			);
		} finally {
			db.close();
		}
	}

	beforeEach(() => {
		resolverCalls = 0;
	});

	afterEach(async () => {
		setSystemTime();
		for (const { dir, store, storage } of opened.splice(0)) {
			storage.close();
			store.close();
			await removeWithRetries(dir);
		}
	});

	test("no rows is not usable", async () => {
		const { storage } = await open();
		expect(storage.keys.hasUsable(SCOPED)).toBe(false);
		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-a" })).toBe(false);
	});

	test("a store whose block reads and peek disagree is rejected and closed", async () => {
		const { storage } = await open();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-has-usable-unpaired-"));
		try {
			const shapes = [["peekCredentialBlock"], ["getCredentialBlock", "getCredentialBlockScopes"]] as const;
			for (const [index, drops] of shapes.entries()) {
				const incoming = await SqliteAuthCredentialStore.open(path.join(dir, `${index}.db`));
				for (const drop of drops) Object.defineProperty(incoming, drop, { value: undefined });
				const close = spyOn(incoming, "close");
				await expect(storage.replaceStore(incoming)).rejects.toThrow("peekCredentialBlock exactly");
				expect(close).toHaveBeenCalledTimes(1);
			}
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("one stored API key is usable", async () => {
		const { storage } = await open();
		await storage.credentials.set(SCOPED, { type: "api_key", key: "key-1" });
		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-a" })).toBe(true);
	});

	test("one blocked stored API key follows get's singleton fast path", async () => {
		const { store, storage } = await open();
		await storage.credentials.set(SCOPED, { type: "api_key", key: "key-1", source: "login" });
		const [credentialId] = idsOf(store, SCOPED);
		if (credentialId === undefined) throw new Error("credential missing");
		store.upsertCredentialBlock({
			credentialId,
			providerKey: `${SCOPED}:api_key`,
			blockScope: "model:model-a",
			blockedUntilMs: Date.now() + HOUR_MS,
		});

		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-a" })).toBe(true);
		expect(await storage.getApiKey(SCOPED, undefined, { modelId: "model-a" })).toBe("key-1");
	});

	test("multi-scope strategy checks shared and model blocks for API-key rows", async () => {
		const { store, storage } = await open();
		await storage.credentials.set(SCOPED, [
			{ type: "api_key", key: "key-1", source: "login" },
			{ type: "api_key", key: "key-2", source: "login" },
		]);
		const [modelBlockedId, sharedBlockedId] = idsOf(store, SCOPED);
		if (modelBlockedId === undefined || sharedBlockedId === undefined) throw new Error("credentials missing");
		store.upsertCredentialBlock({
			credentialId: modelBlockedId,
			providerKey: `${SCOPED}:api_key`,
			blockScope: "model:model-a",
			blockedUntilMs: Date.now() + HOUR_MS,
		});
		store.upsertCredentialBlock({
			credentialId: sharedBlockedId,
			providerKey: `${SCOPED}:api_key`,
			blockScope: "shared",
			blockedUntilMs: Date.now() + HOUR_MS,
		});

		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-a" })).toBe(false);
		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-b" })).toBe(true);
	});

	test("multi-scope strategy checks shared and model blocks for OAuth rows", async () => {
		const { store, storage } = await open();
		await storage.credentials.set(SCOPED, [oauth("model"), oauth("shared")]);
		const [modelBlockedId, sharedBlockedId] = idsOf(store, SCOPED);
		if (modelBlockedId === undefined || sharedBlockedId === undefined) throw new Error("credentials missing");
		store.upsertCredentialBlock({
			credentialId: modelBlockedId,
			providerKey: `${SCOPED}:oauth`,
			blockScope: "model:model-a",
			blockedUntilMs: Date.now() + HOUR_MS,
		});
		store.upsertCredentialBlock({
			credentialId: sharedBlockedId,
			providerKey: `${SCOPED}:oauth`,
			blockScope: "shared",
			blockedUntilMs: Date.now() + HOUR_MS,
		});

		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-a" })).toBe(false);
		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-b" })).toBe(true);
	});

	test("an expired block no longer counts and its row is not pruned", async () => {
		const { dbPath, store, storage } = await open();
		await storage.credentials.set(PLAIN, [
			{ type: "api_key", key: "key-1" },
			{ type: "api_key", key: "key-2" },
		]);
		const ids = idsOf(store, PLAIN);
		for (const credentialId of ids) {
			store.upsertCredentialBlock({
				credentialId,
				providerKey: `${PLAIN}:api_key`,
				blockScope: "",
				blockedUntilMs: Date.now() + HOUR_MS,
			});
		}
		expect(storage.keys.hasUsable(PLAIN)).toBe(false);
		setSystemTime(new Date(Date.now() + 2 * HOUR_MS));
		expect(storage.keys.hasUsable(PLAIN)).toBe(true);
		for (const credentialId of ids) expect(blockRowCount(dbPath, credentialId)).toBe(1);
	});

	test("a failed block read leaves the in-memory block deciding, as get does", async () => {
		const { store, storage } = await open();
		await storage.credentials.set(PLAIN, [
			{ type: "api_key", key: "key-1" },
			{ type: "api_key", key: "key-2" },
		]);
		for (const credentialId of idsOf(store, PLAIN)) {
			await storage.limits.markReached(PLAIN, undefined, { credentialId, retryAfterMs: HOUR_MS });
		}
		store.peekCredentialBlock = () => {
			throw new Error("block read failed");
		};
		store.getCredentialBlock = () => {
			throw new Error("block read failed");
		};
		expect(storage.keys.hasUsable(PLAIN)).toBe(false);
	});

	test("a corrupt block store keeps in-memory blocks deciding, as get does", async () => {
		const { store, storage } = await open();
		await storage.credentials.set(PLAIN, [
			{ type: "api_key", key: "key-1" },
			{ type: "api_key", key: "key-2" },
		]);
		for (const credentialId of idsOf(store, PLAIN)) {
			await storage.limits.markReached(PLAIN, undefined, { credentialId, retryAfterMs: HOUR_MS });
		}
		const corrupt = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
		const throwCorrupt = () => {
			throw corrupt;
		};
		store.getCredentialBlock = throwCorrupt;
		store.getCredentialBlockScopes = throwCorrupt;
		let peeks = 0;
		store.peekCredentialBlock = () => {
			peeks += 1;
			throw corrupt;
		};
		await storage.getApiKey(PLAIN, "latch");
		expect(storage.keys.hasUsable(PLAIN)).toBe(false);
		// Latched: the damaged store is not read again; only in-memory blocks decide.
		expect(peeks).toBe(0);
	});

	test("a mirrored block deleted by another process no longer counts", async () => {
		const { dbPath, store, storage } = await open();
		await storage.credentials.set(PLAIN, [
			{ type: "api_key", key: "key-1" },
			{ type: "api_key", key: "key-2" },
		]);
		const ids = idsOf(store, PLAIN);
		for (const credentialId of ids) {
			await storage.limits.markReached(PLAIN, undefined, { credentialId, retryAfterMs: HOUR_MS });
		}
		expect(storage.keys.hasUsable(PLAIN)).toBe(false);
		const sibling = await SqliteAuthCredentialStore.open(dbPath);
		for (const credentialId of ids) sibling.deleteCredentialBlocks(credentialId);
		sibling.close();
		expect(storage.keys.hasUsable(PLAIN)).toBe(true);
	});

	test("a block persisted by another process counts", async () => {
		const { dbPath, store, storage } = await open();
		await storage.credentials.set(PLAIN, [
			{ type: "api_key", key: "key-1" },
			{ type: "api_key", key: "key-2" },
		]);
		const sibling = await SqliteAuthCredentialStore.open(dbPath);
		for (const credentialId of idsOf(store, PLAIN)) {
			sibling.upsertCredentialBlock({
				credentialId,
				providerKey: `${PLAIN}:api_key`,
				blockScope: "",
				blockedUntilMs: Date.now() + HOUR_MS,
			});
		}
		sibling.close();
		expect(storage.keys.hasUsable(PLAIN)).toBe(false);
	});

	test("an expired OAuth token counts only when it can be refreshed", async () => {
		const { storage } = await open();
		await storage.credentials.set(PLAIN, oauth("a", { expires: Date.now() - HOUR_MS }));
		expect(storage.keys.hasUsable(PLAIN)).toBe(true);
		await storage.credentials.set(PLAIN, oauth("a", { expires: Date.now() - HOUR_MS, refresh: "" }));
		expect(storage.keys.hasUsable(PLAIN)).toBe(false);
	});

	test("repeated checks leave round-robin order and stickiness unchanged", async () => {
		const keys = [
			{ type: "api_key" as const, key: "key-1" },
			{ type: "api_key" as const, key: "key-2" },
			{ type: "api_key" as const, key: "key-3" },
		];
		const checked = await open();
		const control = await open();
		await checked.storage.credentials.set(PLAIN, keys);
		await control.storage.credentials.set(PLAIN, keys);

		const sequence = async (storage: AuthStorage, check: boolean): Promise<Array<string | undefined>> => {
			const seen: Array<string | undefined> = [];
			seen.push(await storage.getApiKey(PLAIN, "session-1"));
			for (let i = 0; i < 4; i += 1) {
				if (check) {
					for (let n = 0; n < 5; n += 1) {
						storage.keys.hasUsable(PLAIN);
					}
				}
				seen.push(await storage.getApiKey(PLAIN));
			}
			if (check) {
				for (let n = 0; n < 5; n += 1) {
					storage.keys.hasUsable(PLAIN);
				}
			}
			seen.push(storage.keys.describe(PLAIN, "session-1"));
			seen.push(await storage.getApiKey(PLAIN, "session-1"));
			return seen;
		};

		expect(await sequence(checked.storage, true)).toEqual(await sequence(control.storage, false));
	});

	test("never writes to the store, refreshes, polls, or resolves key references", async () => {
		const { store, storage } = await open();
		await storage.credentials.set(SCOPED, [
			oauth("expired", { expires: Date.now() - HOUR_MS }),
			{ type: "api_key", key: "ENV_REFERENCE", source: "login" },
		]);
		const [first] = idsOf(store, SCOPED);
		await storage.limits.markReached(SCOPED, undefined, {
			credentialId: first,
			modelId: "model-a",
			retryAfterMs: HOUR_MS,
		});
		resolverCalls = 0;

		const forbidden = [
			"updateAuthCredential",
			"deleteAuthCredential",
			"tryDisableAuthCredentialIfMatches",
			"tryUpdateAuthCredentialIfMatches",
			"replaceAuthCredentials",
			"upsertAuthCredential",
			"deleteAuthCredentials",
			"setCache",
			"deleteCachePrefix",
			"deleteCredentialBlocks",
			"getCredentialBlock",
			"getCredentialBlockReconcileAfter",
			"cleanExpiredCredentialBlocks",
			"listCredentialBlocks",
			"upsertCredentialBlock",
			"deleteCredentialBlock",
			"recordUsageSnapshots",
			"pollExternalChanges",
			"tryAcquireCredentialRefreshLease",
		] as const;
		const spies = forbidden.map(name => spyOn(store, name));

		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-a" })).toBe(false);
		expect(storage.keys.hasUsable(SCOPED, { modelId: "model-b" })).toBe(true);
		for (const [index, spy] of spies.entries()) {
			expect({ method: forbidden[index], calls: spy.mock.calls.length }).toEqual({
				method: forbidden[index],
				calls: 0,
			});
		}
		expect(resolverCalls).toBe(0);
		const stored = store.listAuthCredentials(SCOPED).find(row => row.credential.type === "oauth")?.credential;
		expect(stored?.type === "oauth" ? stored.access : undefined).toBe("access-expired");
	});
});
