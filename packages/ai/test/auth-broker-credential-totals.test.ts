import {
	MAX_OBSERVED_LIMIT_OBSERVATIONS,
	MAX_OBSERVED_OUTCOMES,
	MAX_OBSERVED_REPORT_BYTES,
	MAX_OBSERVED_USAGE_ENTRIES,
} from "@oh-my-pi/pi-ai/auth-broker/types";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import type {
	ClientUsageReport,
	ObservedLimitObservation,
	ObservedUsageEntry,
	UsageLimit,
} from "@oh-my-pi/pi-ai/usage";
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

function requestLimit(remaining: number, modelClass = "opus-5.5", window = "requests"): UsageLimit {
	return {
		id: `anthropic:api:${modelClass}:${window}`,
		label: "Requests",
		scope: { provider: "anthropic" },
		amount: { used: 50 - remaining, limit: 50, remaining, unit: "requests" },
	};
}

/** The request schema a broker from before credential identity enforced. */
const legacyReportSchema = type({
	"+": "reject",
	installId: "string",
	"hostname?": "string",
	"app?": "string",
	entries: type({
		"+": "reject",
		at: "number",
		provider: "string",
		model: "string",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		costUsd: "number",
	}).array(),
});

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
		return storage!.usage.credentialTotals().find(row => row.credentialId === credentialId && row.metric === metric)
			?.value;
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
			{
				credentialId: keyId,
				provider: "anthropic",
				credentialType: "api_key",
				metric: "estimated_cost_usd",
				value: 0.25,
			},
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "requests:ok", value: 1 },
			{
				credentialId: keyId,
				provider: "anthropic",
				credentialType: "api_key",
				metric: "tokens:cache_read",
				value: 10,
			},
			{
				credentialId: keyId,
				provider: "anthropic",
				credentialType: "api_key",
				metric: "tokens:cache_write",
				value: 5,
			},
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "tokens:input", value: 100 },
			{ credentialId: keyId, provider: "anthropic", credentialType: "api_key", metric: "tokens:output", value: 40 },
		]);
		await stopBroker();
		await startBroker();
		expect(total("tokens:input")).toBe(100);
		expect(total("requests:ok")).toBe(1);
		expect(await post({ installId: "i-1", entries: [usageEntry({ credentialId: keyId, inputTokens: 1 })] })).toBe(
			200,
		);
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
				{
					at: Date.now(),
					provider: "anthropic",
					model: "claude-x",
					credentialId: 999_999,
					outcome: "error",
					requests: 1,
				},
			],
			limits: [
				{
					at: Date.now(),
					provider: "anthropic",
					credentialId: retired.id,
					modelClass: "opus-5.5",
					limits: [requestLimit(10)],
				},
			],
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
					{
						at: Date.now(),
						provider: "anthropic",
						model: "claude-x",
						credentialId: keyId,
						outcome: "error",
						requests: 3,
					},
					{
						at: Date.now(),
						provider: "anthropic",
						model: "claude-x",
						credentialId: keyId,
						outcome: "aborted",
						requests: 1,
					},
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

	test("limit observations use broker receipt ordering and survive a reopen", async () => {
		let receiptTime = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => receiptTime++);
		const observe = (at: number, remaining: number) =>
			post({
				installId: "i-limits",
				entries: [],
				limits: [
					{
						at,
						provider: "anthropic",
						credentialId: keyId,
						modelClass: "opus-5.5",
						limits: [requestLimit(remaining)],
					},
				],
			});
		const clientAt = receiptTime;
		expect(await observe(clientAt, 20)).toBe(200);
		expect(await observe(clientAt + 1_000, 12)).toBe(200);
		expect(await observe(clientAt + 500, 30)).toBe(200);
		expect(
			await post({
				installId: "i-limits",
				entries: [],
				limits: [
					{
						at: Number.MAX_SAFE_INTEGER,
						provider: "anthropic",
						credentialId: keyId,
						limits: [],
						error: "credit_exhausted",
					},
				],
			}),
		).toBe(200);
		await stopBroker();
		await startBroker();
		const stored = storage!.usage.limitObservations();
		expect(stored.find(observation => observation.modelClass === "opus-5.5")?.limits[0]?.amount.remaining).toBe(30);
		expect(stored.find(observation => observation.error)?.error).toBe("credit_exhausted");
		expect(stored.every(observation => observation.at < Number.MAX_SAFE_INTEGER)).toBe(true);
	});

	test("an old broker's unknown identity fields trigger legacy fallback", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: unknown[] = [];
		const accepted: ClientUsageReport[] = [];
		let flushes = Promise.withResolvers<void>();
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			sent.push(structuredClone(report));
			const valid = legacyReportSchema(report);
			if (valid instanceof type.errors) {
				const field = valid.summary.match(/(batchId|credentialId|outcome|limits) must be removed/)?.[1];
				if (field)
					throw new AuthBrokerError("Auth broker request failed: 400 Bad Request", {
						status: 400,
						body: JSON.stringify({ error: valid.summary }),
					});
			}
			accepted.push(report);
			const ack = await real(report, signal);
			flushes.resolve();
			return ack;
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		const identity = { installId: "i-old-broker", app: "omp" };
		remote.recordObservedUsage([usageEntry({ credentialId: keyId, outcome: "error" })], identity);
		remote.recordObservedOutcomes(
			[
				{
					at: Date.now(),
					provider: "anthropic",
					model: "claude-x",
					credentialId: keyId,
					outcome: "error",
					requests: 1,
				},
			],
			identity,
		);
		await flushes.promise;
		flushes = Promise.withResolvers<void>();
		remote.recordObservedUsage([usageEntry({ credentialId: keyId })], identity);
		await flushes.promise;
		expect(sent).toHaveLength(3);
		expect(accepted).toHaveLength(2);
		expect(clientRequests("i-old-broker")).toBe(2);
		expect(storage!.usage.credentialTotals()).toEqual([]);
	});

	test("a current-broker schema 400 does not latch legacy reporting", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const rejected = Promise.withResolvers<void>();
		const laterAccepted = Promise.withResolvers<void>();
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			sent.push(structuredClone(report));
			try {
				const response = await real(report, signal);
				laterAccepted.resolve();
				return response;
			} catch (error) {
				if (sent.length === 1) rejected.resolve();
				throw error;
			}
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		const identity = { installId: "i-schema-400", app: "omp" };
		remote.recordObservedUsage([usageEntry({ provider: "p".repeat(129), credentialId: keyId })], identity);
		await rejected.promise;
		remote.recordObservedUsage([usageEntry({ credentialId: keyId })], identity);
		await laterAccepted.promise;
		expect(sent).toHaveLength(2);
		expect(sent[0]?.entries[0]?.credentialId).toBe(keyId);
		expect(sent[1]?.entries[0]?.credentialId).toBe(keyId);
		expect(clientRequests("i-schema-400")).toBe(1);
	});

	test("a partial response keeps the other limit ids buffered in the same flush", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const flushed = Promise.withResolvers<void>();
		let failure: unknown;
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			try {
				const ack = await real(report, signal);
				flushed.resolve();
				return ack;
			} catch (error) {
				failure = error;
				flushed.resolve();
				throw error;
			}
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 50 });
		const at = Date.now();
		const row = { provider: "anthropic", credentialId: keyId, modelClass: "opus-5.5" };
		remote.recordObservedLimits([
			{ ...row, at, limits: [requestLimit(40), requestLimit(10, "opus-5.5", "input-tokens")] },
		]);
		remote.recordObservedLimits([{ ...row, at: at + 10, limits: [requestLimit(39)] }]);
		remote.recordObservedLimits([{ ...row, at: at + 20, limits: [], error: "rate_limited" }]);
		await flushed.promise;
		expect(failure).toBeUndefined();
		const stored = storage!.usage.limitObservations();
		expect(stored.map(observation => observation.limits[0]?.id ?? observation.error)).toEqual([
			"anthropic:api:opus-5.5:input-tokens",
			"anthropic:api:opus-5.5:requests",
			"rate_limited",
		]);
	});

	test("one flush keeps two credential rows for the same client, provider and model apart", async () => {
		await storage!.credentials.set("anthropic", [
			{ type: "api_key", key: "sk-ant-api03-row-one" },
			{ type: "api_key", key: "sk-ant-api03-row-two" },
		]);
		const [firstId, secondId] = storage!.credentials.list("anthropic").map(row => row.id);
		if (firstId === undefined || secondId === undefined) throw new Error("expected two credential rows");
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const flushed = Promise.withResolvers<void>();
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			sent.push(report);
			const ack = await real(report, signal);
			flushed.resolve();
			return ack;
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 50 });
		const identity = { installId: "i-two-rows", app: "omp" };
		remote.recordObservedUsage([usageEntry({ credentialId: firstId, inputTokens: 7 })], identity);
		remote.recordObservedUsage([usageEntry({ credentialId: secondId, inputTokens: 11 })], identity);
		await flushed.promise;
		expect(sent).toHaveLength(1);
		expect(sent[0]?.entries).toHaveLength(2);
		expect(total("tokens:input", firstId)).toBe(7);
		expect(total("tokens:input", secondId)).toBe(11);
		expect(clientRequests("i-two-rows")).toBe(2);
	});

	test("the report schema rejects unbounded or unknown limit fields with 400", async () => {
		const limitReport = (observation: Record<string, unknown>) =>
			fetch(`${handle!.url}/v1/usage/observed`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					installId: "i-bounds",
					entries: [],
					limits: [{ at: Date.now(), provider: "anthropic", credentialId: keyId, ...observation }],
				}),
			}).then(res => res.status);
		expect(await limitReport({ modelClass: "opus-5.5", limits: [requestLimit(1)] })).toBe(200);
		// A limit id outside the parser's closed set for the row.
		expect(
			await limitReport({ modelClass: "opus-5.5", limits: [{ ...requestLimit(1), id: `junk-${"x".repeat(40)}` }] }),
		).toBe(400);
		expect(await limitReport({ modelClass: "opus-5.5", limits: [requestLimit(1, "sonnet")] })).toBe(400);
		// A model class outside the row grammar, or one that would make the id ambiguous.
		expect(await limitReport({ modelClass: "Opus:5", limits: [] })).toBe(400);
		expect(await limitReport({ modelClass: "a".repeat(33), limits: [] })).toBe(400);
		// Too many windows for one row, and free-form nested strings.
		const four = ["requests", "input-tokens", "output-tokens", "requests"].map(w => requestLimit(1, "opus-5.5", w));
		expect(await limitReport({ modelClass: "opus-5.5", limits: four })).toBe(400);
		expect(
			await limitReport({ modelClass: "opus-5.5", limits: [{ ...requestLimit(1), notes: ["x".repeat(10_000)] }] }),
		).toBe(400);
		expect(
			await limitReport({ modelClass: "opus-5.5", limits: [{ ...requestLimit(1), label: "x".repeat(65) }] }),
		).toBe(400);
		// An oversize limits array.
		const observation = { at: Date.now(), provider: "anthropic", credentialId: keyId, limits: [] };
		const oversize = await fetch(`${handle!.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installId: "i-bounds", entries: [], limits: Array(1025).fill(observation) }),
		});
		expect(oversize.status).toBe(400);
		expect(storage!.usage.limitObservations()).toHaveLength(1);
	});

	test("a fourth model class evicts the least recently received class's rows", async () => {
		let receiptTime = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => receiptTime++);
		const observe = (modelClass: string, remaining: number) =>
			post({
				installId: "i-classes",
				entries: [],
				limits: [
					{
						at: Date.now(),
						provider: "anthropic",
						credentialId: keyId,
						modelClass,
						limits: [requestLimit(remaining, modelClass), requestLimit(remaining, modelClass, "input-tokens")],
					},
				],
			});
		expect(await observe("row-a", 10)).toBe(200);
		expect(await observe("row-b", 20)).toBe(200);
		expect(await observe("row-c", 30)).toBe(200);
		expect(await observe("row-a", 11)).toBe(200);
		expect(await observe("row-d", 40)).toBe(200);
		const classes = new Set(storage!.usage.limitObservations().map(observation => observation.modelClass));
		expect([...classes].sort()).toEqual(["row-a", "row-c", "row-d"]);
		expect(storage!.usage.limitObservations()).toHaveLength(6);
	});
	test("limit freshness uses broker receipt time instead of client timestamps", async () => {
		const farFuture = Number.MAX_SAFE_INTEGER;
		const observe = (at: number) =>
			post({
				installId: "i-clock",
				entries: [],
				limits: [{ at, provider: "anthropic", credentialId: keyId, limits: [], error: "credit_exhausted" }],
			});
		expect(await observe(farFuture)).toBe(200);
		expect(await observe(Date.now())).toBe(200);
		const [status] = storage!.usage.limitObservations();
		expect(status?.error).toBe("credit_exhausted");
		expect(status?.at).toBeLessThan(farFuture);
	});

	test("row-wide error status does not consume a model-class eviction slot", async () => {
		const observeClass = (modelClass: string) =>
			post({
				installId: "i-row-wide",
				entries: [],
				limits: [
					{
						at: Date.now(),
						provider: "anthropic",
						credentialId: keyId,
						modelClass,
						limits: [requestLimit(10, modelClass)],
					},
				],
			});
		expect(await observeClass("row-a")).toBe(200);
		expect(await observeClass("row-b")).toBe(200);
		expect(await observeClass("row-c")).toBe(200);
		expect(
			await post({
				installId: "i-row-wide",
				entries: [],
				limits: [{ at: Date.now(), provider: "anthropic", credentialId: keyId, limits: [], error: "rate_limited" }],
			}),
		).toBe(200);
		const stored = storage!.usage.limitObservations();
		expect(new Set(stored.map(observation => observation.modelClass))).toEqual(
			new Set(["row-a", "row-b", "row-c", undefined]),
		);
		expect(stored.find(observation => observation.error)?.error).toBe("rate_limited");
	});

	test("the observed reporter carries bounded entry, outcome and limit overflow exactly once", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const flushed = Promise.withResolvers<void>();
		let inFlight = 0;
		let maxInFlight = 0;
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			sent.push(structuredClone(report));
			try {
				const response = await real(report, signal);
				if (
					sent.reduce((sum, batch) => sum + batch.entries.length, 0) === MAX_OBSERVED_USAGE_ENTRIES + 1 &&
					sent.reduce((sum, batch) => sum + (batch.outcomes?.length ?? 0), 0) === MAX_OBSERVED_OUTCOMES + 1 &&
					sent.reduce((sum, batch) => sum + (batch.limits?.length ?? 0), 0) === MAX_OBSERVED_LIMIT_OBSERVATIONS + 1
				)
					flushed.resolve();
				return response;
			} finally {
				inFlight -= 1;
			}
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		const identity = { installId: "i-overflow", app: "omp" };
		for (let index = 0; index < MAX_OBSERVED_USAGE_ENTRIES + 1; index += 1) {
			remote.recordObservedUsage([usageEntry({ model: `entry-${index}` })], identity);
		}
		for (let index = 0; index < MAX_OBSERVED_OUTCOMES + 1; index += 1) {
			remote.recordObservedOutcomes(
				[
					{
						at: Date.now(),
						provider: "anthropic",
						model: `outcome-${index}`,
						credentialId: keyId,
						outcome: "error",
						requests: 1,
					},
				],
				identity,
			);
		}
		for (let index = 0; index < MAX_OBSERVED_LIMIT_OBSERVATIONS + 1; index += 1) {
			const modelClass = `row-${index.toString(36)}`;
			const observation: ObservedLimitObservation = {
				at: Date.now(),
				provider: "anthropic",
				credentialId: keyId,
				modelClass,
				limits: [requestLimit(10, modelClass)],
			};
			remote.recordObservedLimits([observation], identity);
		}
		await flushed.promise;
		expect(sent).toHaveLength(4);
		expect(
			sent.map(report => [report.entries.length, report.outcomes?.length ?? 0, report.limits?.length ?? 0]),
		).toEqual([
			[MAX_OBSERVED_USAGE_ENTRIES, 0, 0],
			[1, MAX_OBSERVED_OUTCOMES, 0],
			[0, 1, MAX_OBSERVED_LIMIT_OBSERVATIONS],
			[0, 0, 1],
		]);
		expect(sent.flatMap(report => report.entries.map(entry => entry.model)).sort()).toEqual(
			Array.from({ length: MAX_OBSERVED_USAGE_ENTRIES + 1 }, (_, index) => `entry-${index}`).sort(),
		);
		expect(sent.flatMap(report => report.outcomes?.map(outcome => outcome.model) ?? []).sort()).toEqual(
			Array.from({ length: MAX_OBSERVED_OUTCOMES + 1 }, (_, index) => `outcome-${index}`).sort(),
		);
		expect(
			sent.flatMap(report => report.limits?.map(observation => observation.modelClass ?? "") ?? []).sort(),
		).toEqual(
			Array.from({ length: MAX_OBSERVED_LIMIT_OBSERVATIONS + 1 }, (_, index) => `row-${index.toString(36)}`).sort(),
		);
		expect(maxInFlight).toBe(1);
		for (const report of sent) {
			expect(report.entries.length).toBeLessThanOrEqual(MAX_OBSERVED_USAGE_ENTRIES);
			expect(report.outcomes?.length ?? 0).toBeLessThanOrEqual(MAX_OBSERVED_OUTCOMES);
			expect(report.limits?.length ?? 0).toBeLessThanOrEqual(MAX_OBSERVED_LIMIT_OBSERVATIONS);
			expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(
				MAX_OBSERVED_REPORT_BYTES,
			);
		}
	});
	test("the limit cap flushes a full limits-only batch", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const firstFlush = Promise.withResolvers<ClientUsageReport>();
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			const response = await real(report, signal);
			firstFlush.resolve(structuredClone(report));
			return response;
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 60_000 });
		const identity = { installId: "i-limit-overflow", app: "omp" };
		for (let index = 0; index < MAX_OBSERVED_LIMIT_OBSERVATIONS + 1; index += 1) {
			const modelClass = `row-${index.toString(36)}`;
			remote.recordObservedLimits(
				[
					{
						at: Date.now(),
						provider: "anthropic",
						credentialId: keyId,
						modelClass,
						limits: [requestLimit(10, modelClass)],
					},
				],
				identity,
			);
		}
		const report = await Promise.race([firstFlush.promise, Bun.sleep(1_000).then(() => undefined)]);
		expect(report).toBeDefined();
		expect(report?.entries).toHaveLength(0);
		expect(report?.outcomes ?? []).toHaveLength(0);
		expect(report?.limits).toHaveLength(MAX_OBSERVED_LIMIT_OBSERVATIONS);
	});

	test("a group whose serialized body exceeds the byte cap is split and every item lands once", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const failures: unknown[] = [];
		const count = MAX_OBSERVED_USAGE_ENTRIES;
		const done = Promise.withResolvers<void>();
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			sent.push(structuredClone(report));
			try {
				return await real(report, signal);
			} catch (error) {
				failures.push(error);
				throw error;
			} finally {
				if (
					sent.reduce((sum, batch) => sum + batch.entries.length, 0) >= count &&
					sent.reduce((sum, batch) => sum + (batch.outcomes?.length ?? 0), 0) >= count
				)
					done.resolve();
			}
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		const identity = { installId: "i-bytes", app: "omp" };
		// Every list is under its count cap and every field under its length cap, yet the body exceeds 1 MiB.
		const model = (index: number) => `${index}-`.padEnd(256, "m");
		for (let index = 0; index < count; index += 1) {
			remote.recordObservedUsage([usageEntry({ model: model(index), credentialId: keyId })], identity);
			// The limits list adds the bytes that push the at-cap lists past 1 MiB.
			const modelClass = `c${index.toString(36)}`.padEnd(32, "x");
			remote.recordObservedLimits(
				[
					{
						at: Date.now(),
						provider: "anthropic",
						credentialId: keyId,
						modelClass,
						limits: [requestLimit(1, modelClass)],
					},
				],
				identity,
			);
			remote.recordObservedOutcomes(
				[
					{
						at: Date.now(),
						provider: "anthropic",
						model: model(index),
						credentialId: keyId,
						outcome: "error",
						requests: 1,
					},
				],
				identity,
			);
		}
		await done.promise;
		expect(failures).toEqual([]);
		// Both lists sit exactly at the count caps, so only the byte cap splits them.
		expect(sent.length).toBeGreaterThan(1);
		for (const report of sent) {
			expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(MAX_OBSERVED_REPORT_BYTES);
		}
		expect(new Set(sent.map(report => report.batchId)).size).toBe(sent.length);
		expect(clientRequests("i-bytes")).toBe(count);
		expect(total("requests:ok")).toBe(count);
		expect(total("requests:error")).toBe(count);
	});

	test("a 413 is not retried, so newer data for that client still lands", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const sent: ClientUsageReport[] = [];
		const second = Promise.withResolvers<void>();
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			sent.push(structuredClone(report));
			if (sent.length === 1) {
				throw new AuthBrokerError("Auth broker request failed: 413 Payload Too Large", { status: 413 });
			}
			const ack = await real(report, signal);
			second.resolve();
			return ack;
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		const identity = { installId: "i-413", app: "omp" };
		remote.recordObservedUsage([usageEntry({ model: "first" })], identity);
		await Bun.sleep(100);
		remote.recordObservedUsage([usageEntry({ model: "second" })], identity);
		await second.promise;
		expect(sent.map(report => report.entries.map(entry => entry.model))).toEqual([["first"], ["second"]]);
		expect(sent[1]?.batchId).not.toBe(sent[0]?.batchId);
	});

	test("a retry of an earlier failed report is posted before a later flush's newer limit", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const real = client.reportClientUsage.bind(client);
		const order: number[] = [];
		const firstSent = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(client, "reportClientUsage").mockImplementation(async (report, signal) => {
			calls += 1;
			const remaining = report.limits?.[0]?.limits[0]?.amount.remaining ?? -1;
			order.push(remaining);
			if (calls === 1) {
				firstSent.resolve();
				await releaseFirst.promise;
				throw new Error("connection reset");
			}
			const ack = await real(report, signal);
			if (order.length >= 3) settled.resolve();
			return ack;
		});
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false, observedUsageFlushMs: 20 });
		const identity = { installId: "i-order", app: "omp" };
		const observe = (remaining: number) =>
			remote!.recordObservedLimits(
				[
					{
						at: Date.now(),
						provider: "anthropic",
						credentialId: keyId,
						modelClass: "opus-5.5",
						limits: [requestLimit(remaining)],
					},
				],
				identity,
			);
		observe(10);
		await firstSent.promise;
		// The newer observation is flushed while the older report is still in flight.
		observe(3);
		await Bun.sleep(60);
		releaseFirst.resolve();
		await settled.promise;
		expect(order).toEqual([10, 10, 3]);
		const stored = storage!.usage.limitObservations().find(observation => observation.credentialId === keyId);
		expect(stored?.limits[0]?.amount.remaining).toBe(3);
	});

	test("a client clock ahead of the broker never dates usage past receipt", async () => {
		const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
		expect(await post({ installId: "i-future", entries: [usageEntry({ at: future })] })).toBe(200);
		expect(
			storage!.usage.clientSummary(future - 1000).clients.find(c => c.installId === "i-future")?.providers,
		).toEqual([]);
		expect(clientRequests("i-future")).toBe(1);
	});

	test("the report request is bounded by bytes and rejects unbounded identity and numeric fields", async () => {
		const tooLarge = await fetch(`${handle!.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: " ".repeat(MAX_OBSERVED_REPORT_BYTES + 1),
		});
		expect(tooLarge.status).toBe(413);
		const report = (overrides: Record<string, unknown>) =>
			fetch(`${handle!.url}/v1/usage/observed`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ installId: "i-boundary", entries: [usageEntry()], ...overrides }),
			}).then(response => response.status);
		const tooManyEntries = await fetch(`${handle!.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				installId: "i-boundary",
				entries: Array(MAX_OBSERVED_USAGE_ENTRIES + 1).fill(usageEntry()),
			}),
		});
		expect(tooManyEntries.status).toBe(400);
		expect(await report({ installId: "i".repeat(257) })).toBe(400);
		expect(await report({ entries: [usageEntry({ provider: "p".repeat(129) })] })).toBe(400);
		expect(await report({ hostname: "h".repeat(257) })).toBe(400);
		expect(await report({ app: "a".repeat(129) })).toBe(400);
		expect(await report({ entries: [usageEntry({ provider: "p".repeat(129) })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ inputTokens: 1_000_000_000_001 })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ outputTokens: 1_000_000_000_001 })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ cacheReadTokens: 1_000_000_000_001 })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ cacheWriteTokens: 1_000_000_000_001 })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ model: "m".repeat(257) })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ requests: 1_000_000_000_001 })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ costUsd: 1_000_000_001 })] })).toBe(400);
		expect(await report({ entries: [usageEntry({ unexpected: "persist me" } as Partial<ObservedUsageEntry>)] })).toBe(
			400,
		);
		expect(
			await post({
				installId: "i-boundary",
				entries: [],
				limits: [
					{
						at: Number.MAX_SAFE_INTEGER + 1,
						provider: "anthropic",
						credentialId: keyId,
						modelClass: "opus-5.5",
						limits: [requestLimit(10)],
					},
				],
			}),
		).toBe(400);
		expect(
			await post({
				installId: "i-boundary",
				entries: [],
				limits: [
					{
						at: Date.now(),
						provider: "anthropic",
						credentialId: keyId,
						modelClass: "opus-5.5",
						limits: [
							{
								...requestLimit(10),
								amount: { ...requestLimit(10).amount, injected: "not persisted" } as UsageLimit["amount"],
							},
						],
					},
				],
			}),
		).toBe(400);
	});
});
