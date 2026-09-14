/**
 * A provider whose reports carry NO account, email, project or organization
 * identity — `synthetic`, `charm-hyper` — also uses fixed limit ids, so every
 * one of its credentials renders an identical Prometheus label set and the
 * exposition drops all but the first as a duplicate. AuthStorage stamps a
 * stable, non-secret per-credential discriminator on exactly those reports.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: () => rows,
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
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

function apiKeyRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = { type: "api_key", key: `sk-${id}` };
	return { id, provider: "synthetic", credential, disabledCause: null };
}

/** An identity-less report: fixed limit id, no account/email/project/org. */
function identitylessReport(): UsageReport {
	return {
		provider: "synthetic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "synthetic:monthly",
				label: "Monthly",
				scope: { provider: "synthetic", windowId: "monthly" },
				amount: { usedFraction: 0.25, unit: "percent" },
			},
		],
		metadata: { endpoint: "https://example.invalid/quotas" },
	};
}

function stubProvider(build: () => UsageReport): UsageProvider {
	return {
		id: "synthetic",
		fetchUsage: async () => build(),
	} as UsageProvider;
}

describe("AuthStorage identity-less usage reports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stamps a distinct credential key on each identity-less credential's report", async () => {
		const storage = new AuthStorage(makeStore([apiKeyRow(11), apiKeyRow(12)]), {
			usageProviderResolver: provider => (provider === "synthetic" ? stubProvider(identitylessReport) : undefined),
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const synthetic = reports.filter(report => report.provider === "synthetic");
			const keys = synthetic.map(report => report.metadata?.credentialKey);

			// RED (pre-fix): no stamp, so both reports were byte-identical and the
			// renderer collapsed them into one series.
			expect(new Set(keys).size).toBe(2);
			expect(keys.every(key => typeof key === "string" && key.length > 0)).toBe(true);
		} finally {
			storage.close();
		}
	}, 20_000);

	it("leaves a report that carries its own identity unstamped", async () => {
		const withAccount = (): UsageReport => ({ ...identitylessReport(), metadata: { accountId: "acct-real" } });
		const storage = new AuthStorage(makeStore([apiKeyRow(11)]), {
			usageProviderResolver: provider => (provider === "synthetic" ? stubProvider(withAccount) : undefined),
		});
		await storage.reload();
		try {
			const reports = (await storage.fetchUsageReports()) ?? [];
			const synthetic = reports.filter(report => report.provider === "synthetic");
			expect(synthetic).toHaveLength(1);
			// The stamp must never re-key a series that can already be attributed.
			expect(synthetic[0].metadata?.credentialKey).toBeUndefined();
		} finally {
			storage.close();
		}
	}, 20_000);
});
