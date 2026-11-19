import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthAccountPolicies,
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, { value: string; expiresAtSec: number }>;
}

function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return rows;
		},
		async upsertAuthCredential() {
			return rows;
		},
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number, email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

const HOUR = 3_600_000;

/** Claude report: shared windows low, Fable weekly row at `fableUsed`, reset in the future. */
function fableReport(
	email: string,
	fableUsed: number,
	fableResetsAt: number | undefined = Date.now() + 2 * HOUR,
): UsageReport {
	const shared = (id: "anthropic:5h" | "anthropic:7d", used: number): UsageLimit => ({
		id,
		label: id,
		scope: { provider: "anthropic", windowId: id === "anthropic:5h" ? "5h" : "7d", shared: true },
		window: {
			id: id === "anthropic:5h" ? "5h" : "7d",
			label: id,
			durationMs: id === "anthropic:5h" ? 5 * HOUR : 7 * 24 * HOUR,
		},
		amount: { unit: "percent", used: used * 100, limit: 100, usedFraction: used, remainingFraction: 1 - used },
		status: used >= 1 ? "exhausted" : "ok",
	});
	const fable: UsageLimit = {
		id: "anthropic:7d:fable",
		label: "Claude 7 Day (Fable)",
		scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
		window: {
			id: "7d",
			label: "7 Day",
			durationMs: 7 * 24 * HOUR,
			...(fableResetsAt === undefined ? {} : { resetsAt: fableResetsAt }),
		},
		amount: {
			unit: "percent",
			used: fableUsed * 100,
			limit: 100,
			usedFraction: fableUsed,
			remainingFraction: 1 - fableUsed,
		},
		status: fableUsed >= 1 ? "exhausted" : "ok",
	};
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [shared("anthropic:5h", 0.1), shared("anthropic:7d", 0.1), fable],
		metadata: { email, accountId: email },
	};
}

const FABLE_PIN = ["claude-fable-*"];

function policies(pinModels: string[] | undefined): AuthAccountPolicies {
	return [1, 2, 3].map(id => ({
		provider: "anthropic",
		account: { accountId: `account-${id}` },
		...(pinModels === undefined ? {} : { pinModels }),
	}));
}

describe("AuthStorage Fable account pinning", () => {
	let store: ObservableStore;
	const storages: AuthStorage[] = [];

	beforeEach(() => {
		store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com"), oauthRow(3, "c@example.com")]);
	});

	afterEach(() => {
		for (const storage of storages.splice(0)) storage.close();
		vi.restoreAllMocks();
	});

	async function setup(
		accountPolicies: AuthAccountPolicies,
		fable: Record<string, UsageReport>,
	): Promise<AuthStorage> {
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			return access ? (fable[access] ?? null) : null;
		});
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
			accountPolicies,
		});
		storages.push(storage);
		await storage.credentials.reload();
		return storage;
	}

	it("sends a Fable request to the highest-usage account still below its Fable cap", async () => {
		const storage = await setup(policies(FABLE_PIN), {
			"oat-1": fableReport("a@example.com", 0.4),
			"oat-2": fableReport("b@example.com", 0.7),
			"oat-3": fableReport("c@example.com", 0.2),
		});

		const key = await storage.keys.get("anthropic", "session-fable", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-2");
	});

	it("moves a Fable request to the next account when the pinned Fable window is at 1.0 with no reset", async () => {
		const storage = await setup(policies(FABLE_PIN), {
			"oat-1": fableReport("a@example.com", 0.4),
			"oat-2": fableReport("b@example.com", 1, undefined),
			"oat-3": fableReport("c@example.com", 0.2),
		});

		const key = await storage.keys.get("anthropic", "session-fable", { modelId: "claude-fable-5" });

		expect(key).toBe("oat-1");
	});

	it("leaves non-Fable requests on the unpinned ranking", async () => {
		const reports = {
			"oat-1": fableReport("a@example.com", 0.4),
			"oat-2": fableReport("b@example.com", 0.7),
			"oat-3": fableReport("c@example.com", 0.2),
		};
		const pinned = await (
			await setup(policies(FABLE_PIN), reports)
		).keys.get("anthropic", "session-sonnet", {
			modelId: "claude-sonnet-4-5",
		});
		const unpinned = await (
			await setup(policies(undefined), reports)
		).keys.get("anthropic", "session-sonnet", {
			modelId: "claude-sonnet-4-5",
		});

		expect(pinned).toBe(unpinned);
	});

	it("validates pinModels as a non-empty string array", () => {
		expect(
			() =>
				new AuthStorage(store, {
					usageProviderResolver: () => claudeUsage.claudeUsageProvider,
					accountPolicies: [
						{ provider: "anthropic", account: { accountId: "account-1" }, pinModels: [""] as string[] },
					],
				}),
		).toThrow("auth.accountPolicies[0].pinModels must be an array of non-empty strings");
	});

	it("requires a usage provider when pinModels is set", async () => {
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			accountPolicies: [{ provider: "anthropic", account: { accountId: "account-1" }, pinModels: FABLE_PIN }],
		});
		storages.push(storage);
		await storage.credentials.reload();
		await expect(storage.keys.get("anthropic", "s1")).rejects.toThrow(
			"auth.accountPolicies[0].pinModels requires a usage provider for anthropic",
		);
	});
});
