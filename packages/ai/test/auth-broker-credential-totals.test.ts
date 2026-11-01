import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import type { ClientUsageReport, ObservedUsageEntry, UsageLimit } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const TOKEN = "totals-bearer";

function usageEntry(overrides: Partial<ObservedUsageEntry> = {}): ObservedUsageEntry {
	return {
		at: Date.now(),
		provider: "anthropic",
		model: "claude-x",
		requests: 1,
		inputTokens: 100,
		outputTokens: 40,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		costUsd: 0.25,
		...overrides,
	};
}

function requestLimit(remaining: number): UsageLimit {
	return {
		id: "anthropic:api:opus-5.5:requests",
		label: "Requests",
		scope: { provider: "anthropic" },
		amount: { used: 50 - remaining, limit: 50, remaining, unit: "requests" },
	};
}

describe("broker credential lifetime totals", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let keyId = 0;

	async function startBroker(): Promise<void> {
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	}

	async function stopBroker(): Promise<void> {
		await handle?.close();
		handle = undefined;
		storage?.close();
		storage = undefined;
		store?.close();
		store = undefined;
	}

	async function post(report: ClientUsageReport): Promise<number> {
		const res = await fetch(`${handle!.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(report),
		});
		return res.status;
	}

	function total(metric: string, credentialId = keyId): number | undefined {
		return storage!.usage
			.credentialTotals()
			.find(row => row.credentialId === credentialId && row.metric === metric)?.value;
	}

	function clientRequests(installId: string): number | undefined {
		return storage!.usage
			.clientSummary(0)
			.clients.find(client => client.installId === installId)
			?.providers.find(provider => provider.provider === "anthropic")?.requests;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-totals-"));
		dbPath = path.join(tempDir, "agent.db");
		const seed = await SqliteAuthCredentialStore.open(dbPath);
		await seed.saveApiKey("anthropic", "sk-ant-api03-console-key");
		const [row] = seed.listAuthCredentials("anthropic");
		if (!row) throw new Error("expected seeded credential row");
		keyId = row.id;
		seed.close();
		await startBroker();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		remote = undefined;
		await stopBroker();
		await removeWithRetries(tempDir);
	});

	test("totals persist across a store reopen", async () => {
		expect(await post({ installId: "i-1", entries: [usageEntry({ credentialId: keyId })] })).toBe(200);
		expect(storage!.usage.credentialTotals().filter(row => row.credentialId === keyId)).toEqual([
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "estimated_cost_usd", value: 0.25 },
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "requests:ok", value: 1 },
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "tokens:cache_read", value: 10 },
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "tokens:cache_write", value: 5 },
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "tokens:input", value: 100 },
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "tokens:output", value: 40 },
		]);
		await stopBroker();
		await startBroker();
		expect(total("tokens:input")).toBe(100);
		expect(total("requests:ok")).toBe(1);
		expect(await post({ installId: "i-1", entries: [usageEntry({ credentialId: keyId, inputTokens: 1 })] })).toBe(200);
		expect(total("tokens:input")).toBe(101);
	});

	test("a replayed batchId counts once", async () => {
		const report: ClientUsageReport = {
			installId: "i-replay",
			entries: [usageEntry({ credentialId: keyId })],
			batchId: crypto.randomUUID(),
		};
		expect(await post(report)).toBe(200);
		expect(await post(report)).toBe(200);
		expect(total("tokens:input")).toBe(100);
		expect(total("requests:ok")).toBe(1);
		expect(clientRequests("i-replay")).toBe(1);
	});

	test("a failed-flush retry reuses its batchId and does not double count", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const retried = Promise.withResolvers<void>();
		// First send commits on the broker but the client never sees the ack.
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			sent.push(report);
			const ack = await real(report, signal);
			if (sent.length === 1) throw new Error("connection reset after commit");
			retried.resolve();
			return ack;
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		remote.recordObservedUsage([usageEntry({ credentialId: keyId })], { installId: "i-retry", app: "omp" });
		await retried.promise;
		expect(sent).toHaveLength(2);
		expect(sent[0]?.batchId).toBeString();
		expect(sent[1]?.batchId).toBe(sent[0]?.batchId);
		expect(total("tokens:input")).toBe(100);
		expect(clientRequests("i-retry")).toBe(1);
	});

	test("a stale or mismatched row returns 200, stays unattributed, and keeps client totals", async () => {
		await store!.saveOAuth("openai-codex", {
			access: "codex-access",
			refresh: "codex-refresh",
			expires: Date.now() + 60_000,
			accountId: "codex-account",
		});
		const [codexRow] = store!.listAuthCredentials("openai-codex");
		if (!codexRow) throw new Error("expected codex row");
		await store!.saveApiKey("anthropic", "sk-ant-api03-retired");
		const retired = store!.listAuthCredentials("anthropic").find(row => row.id !== keyId);
		if (!retired) throw new Error("expected retired row");
		await store!.deleteAuthCredential(retired.id, "retired for test");

		const status = await post({
			installId: "i-stale",
			entries: [
				usageEntry({ credentialId: 999_999 }),
				usageEntry({ credentialId: codexRow.id }),
				usageEntry({ credentialId: retired.id }),
			],
			outcomes: [
				{ at: Date.now(), provider: "anthropic", model: "claude-x", credentialId: 999_999, outcome: "error", requests: 1 },
			],
			limits: [{ at: Date.now(), provider: "anthropic", credentialId: retired.id, limits: [requestLimit(10)] }],
		});
		expect(status).toBe(200);
		expect(storage!.usage.credentialTotals()).toEqual([]);
		expect(storage!.usage.limitObservations()).toEqual([]);
		expect(clientRequests("i-stale")).toBe(3);
	});

	test("an Anthropic setup-token stored as api_key counts as oauth", async () => {
		await store!.saveApiKey("anthropic", "sk-ant-oat01-setup-token");
		const setup = store!.listAuthCredentials("anthropic").find(row => row.id !== keyId);
		if (!setup) throw new Error("expected setup-token row");
		expect(setup.credential.type).toBe("api_key");
		expect(await post({ installId: "i-setup", entries: [usageEntry({ credentialId: setup.id })] })).toBe(200);
		const rows = storage!.usage.credentialTotals().filter(row => row.credentialId === setup.id);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every(row => row.credentialType === "oauth")).toBe(true);
	});

	test("outcomes count per credential without changing client request counts", async () => {
		expect(await post({ installId: "i-out", entries: [usageEntry({ credentialId: keyId })] })).toBe(200);
		expect(
			await post({
				installId: "i-out",
				entries: [],
				outcomes: [
					{ at: Date.now(), provider: "anthropic", model: "claude-x", credentialId: keyId, outcome: "error", requests: 3 },
					{ at: Date.now(), provider: "anthropic", model: "claude-x", credentialId: keyId, outcome: "aborted", requests: 1 },
				],
			}),
		).toBe(200);
		expect(total("requests:error")).toBe(3);
		expect(total("requests:aborted")).toBe(1);
		expect(total("requests:ok")).toBe(1);
		expect(total("tokens:input")).toBe(100);
		expect(clientRequests("i-out")).toBe(1);
	});

	test("pruning client history keeps the totals", async () => {
		expect(await post({ installId: "i-prune", entries: [usageEntry({ credentialId: keyId })] })).toBe(200);
		const before = storage!.usage.credentialTotals();
		const raw = new Database(dbPath);
		try {
			raw.run("DELETE FROM client_usage");
		} finally {
			raw.close();
		}
		expect(storage!.usage.clientSummary(0).clients.find(c => c.installId === "i-prune")?.providers).toEqual([]);
		expect(storage!.usage.credentialTotals()).toEqual(before);
	});

	test("an old-shape report behaves as before", async () => {
		const legacy = { installId: "i-legacy", hostname: "old-host", entries: [usageEntry()] };
		expect(await post(legacy)).toBe(200);
		expect(await post(legacy)).toBe(200);
		const client = storage!.usage.clientSummary(0).clients.find(c => c.installId === "i-legacy");
		expect(client?.hostname).toBe("old-host");
		expect(client?.providers).toEqual([
			{
				app: undefined,
				provider: "anthropic",
				requests: 2,
				inputTokens: 200,
				outputTokens: 80,
				cacheReadTokens: 20,
				cacheWriteTokens: 10,
				costUsd: 0.5,
			},
		]);
		expect(storage!.usage.credentialTotals()).toEqual([]);
	});

	test("the latest limit observation wins and survives a reopen", async () => {
		const at = Date.now();
		const observe = (observedAt: number, remaining: number) =>
			post({
				installId: "i-limits",
				entries: [],
				limits: [
					{
						at: observedAt,
						provider: "anthropic",
						credentialId: keyId,
						modelClass: "opus-5.5",
						limits: [requestLimit(remaining)],
					},
				],
			});
		expect(await observe(at, 20)).toBe(200);
		expect(await observe(at + 1_000, 12)).toBe(200);
		// A late-arriving older observation must not replace the newer one.
		expect(await observe(at + 500, 30)).toBe(200);
		expect(
			await post({
				installId: "i-limits",
				entries: [],
				limits: [{ at: at + 2_000, provider: "anthropic", credentialId: keyId, limits: [], error: "credit_exhausted" }],
			}),
		).toBe(200);

		await stopBroker();
		await startBroker();
		expect(storage!.usage.limitObservations()).toEqual([
			{
				at: at + 1_000,
				provider: "anthropic",
				credentialId: keyId,
				modelClass: "opus-5.5",
				limits: [requestLimit(12)],
				credentialType: "api_key",
			},
			{
				at: at + 2_000,
				provider: "anthropic",
				credentialId: keyId,
				limits: [],
				error: "credit_exhausted",
				credentialType: "api_key",
			},
		]);
	});
});
