import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type AgentCaller,
	type AuthGatewayAuthorizer,
	type AuthGatewayServerHandle,
	bearerTokenAuthorizer,
	type CallerIdentity,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";

interface Harness {
	handle: AuthGatewayServerHandle;
	mock: MockModel;
	resolved: string[];
	/** `Authorization` of every upstream call that went through the `fetch` seam. */
	upstreamKeys: (string | null)[];
	close(): Promise<void>;
}

const AGENT_TOKENS: Record<string, string> = { "token-a": "agent-a", "token-b": "agent-b" };

/** Stands in for the verify RPC: one token per agent account. */
const agentAuthorizer: AuthGatewayAuthorizer = req => {
	const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
	const agentAccountId = token ? AGENT_TOKENS[token] : undefined;
	return agentAccountId ? { kind: "agent", agentAccountId } : null;
};

/** An authorizer as a careless RPC adapter would write it: whatever the lookup returns. */
function rawAuthorizer(result: unknown): AuthGatewayAuthorizer {
	return () => result as CallerIdentity | null;
}

async function boot(authorize: AuthGatewayAuthorizer, perAgentPools = true): Promise<Harness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-authorize-"));
	const shared = await AuthStorage.create(path.join(dir, "shared.db"));
	shared.keys.setRuntime("openrouter", "key-shared");
	const pools = new Map<string, AuthStorage>();
	for (const agent of ["agent-a", "agent-b"]) {
		const pool = await AuthStorage.create(path.join(dir, `${agent}.db`));
		pool.keys.setRuntime("openrouter", `key-${agent}`);
		// A stored row names the pool in `/v1/credentials/check`, which lists stored rows only.
		await pool.credentials.set(`pool-${agent}`, { type: "api_key", key: `stored-${agent}` });
		pools.set(agent, pool);
	}
	const resolved: string[] = [];
	const mock = createMockModel({ provider: "openrouter", id: "mock/authorize" });
	const embedding = buildModel({
		id: "text-embedding-3-small",
		name: "text-embedding-3-small",
		api: "openai-embeddings",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: null,
		kind: "embedding",
		supportsTools: false,
	} satisfies ModelSpec<Api>);
	const upstreamKeys: (string | null)[] = [];
	const fetchImpl: FetchImpl = async (_input, init) => {
		upstreamKeys.push(new Headers(init?.headers).get("authorization"));
		return Response.json({
			object: "list",
			data: [{ object: "embedding", index: 0, embedding: [0.5] }],
			model: "text-embedding-3-small",
			usage: { prompt_tokens: 1, total_tokens: 1 },
		});
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize,
		storage: shared,
		resolveStorage: perAgentPools
			? (caller: AgentCaller) => {
					const tenant = caller.ownerUserId ?? caller.agentAccountId;
					resolved.push(tenant);
					const pool = pools.get(tenant);
					if (!pool) throw new Error(`no pool for ${tenant}`);
					return pool;
				}
			: undefined,
		resolveModel: id => (id === embedding.id ? embedding : mock.model),
		version: "test",
		fetch: fetchImpl,
	});
	return {
		handle,
		mock,
		resolved,
		upstreamKeys,
		close: async () => {
			await handle.close();
			shared.close();
			for (const pool of pools.values()) pool.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function chat(
	harness: Harness,
	headers: Record<string, string>,
	extra: Record<string, unknown> = {},
	url = "/v1/chat/completions",
): Promise<Response> {
	return fetch(`${harness.handle.url}${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "mock/authorize",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			...extra,
		}),
	});
}

function piNative(harness: Harness, token: string): Promise<Response> {
	return fetch(`${harness.handle.url}/v1/pi/stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({
			modelId: "mock/authorize",
			context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			options: { sessionId: "shared-session", promptCacheKey: "shared-cache" },
			stream: false,
		}),
	});
}

async function keyOfLastCall(mock: MockModel): Promise<unknown> {
	const apiKey: unknown = mock.calls.at(-1)?.options?.apiKey;
	if (typeof apiKey !== "function") return apiKey;
	const resolved: unknown = await apiKey({ lastChance: false });
	return resolved && typeof resolved === "object" && "apiKey" in resolved ? resolved.apiKey : resolved;
}

async function checkedProviders(harness: Harness, token: string): Promise<string[]> {
	const response = await fetch(`${harness.handle.url}/v1/credentials/check`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { credentials: { provider: string }[] };
	return body.credentials.map(row => row.provider);
}

function captureWarnings(): { events: logger.LogEvent[]; dispose(): void } {
	const events: logger.LogEvent[] = [];
	const dispose = logger.registerLogSink(event => events.push(event));
	return { events, dispose };
}

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
	clearCustomApis();
});

describe("auth-gateway authorize seam", () => {
	it("answers 401 when the authorizer admits nobody, before any pool is resolved", async () => {
		harness = await boot(agentAuthorizer);
		const attempts: Record<string, string>[] = [
			{},
			{ Authorization: "Bearer wrong" },
			{ Authorization: "Basic token-a" },
		];
		for (const headers of attempts) {
			const response = await chat(harness, headers);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		}
		expect(harness.resolved).toEqual([]);
		expect(harness.mock.calls).toHaveLength(0);
	});

	it.each([
		["undefined", undefined],
		["an empty object", {}],
		["an agent without its kind", { agentAccountId: "agent-a" }],
		["an unknown kind", { kind: "admin" }],
		["an empty id", { kind: "agent", agentAccountId: "" }],
		["a non-string id", { kind: "agent", agentAccountId: 7 }],
		["the reserved shared id", { kind: "agent", agentAccountId: "\u0000shared" }],
		["an empty owner", { kind: "agent", agentAccountId: "agent-a", ownerUserId: "" }],
		["a non-string owner", { kind: "agent", agentAccountId: "agent-a", ownerUserId: 7 }],
	])("answers 401 when the authorizer returns %s, never a default caller", async (_label, result) => {
		harness = await boot(rawAuthorizer(result));
		const response = await fetch(`${harness.handle.url}/v1/usage`, { headers: { Authorization: "Bearer token-a" } });
		expect(response.status).toBe(401);
		expect(harness.resolved).toEqual([]);
	});

	it("serves two agents of one owner from that owner's pool, in separate provider sessions", async () => {
		const owned: Record<string, CallerIdentity> = {
			"token-a": { kind: "agent", agentAccountId: "agent-x", ownerUserId: "agent-a" },
			"token-b": { kind: "agent", agentAccountId: "agent-y", ownerUserId: "agent-a" },
		};
		harness = await boot(req => owned[req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""] ?? null);
		harness.mock.push({ content: ["x"] });
		harness.mock.push({ content: ["y"] });
		const extra = { prompt_cache_key: "same-key" };
		expect((await chat(harness, { Authorization: "Bearer token-a" }, extra)).status).toBe(200);
		expect(await keyOfLastCall(harness.mock)).toBe("key-agent-a");
		expect((await chat(harness, { Authorization: "Bearer token-b" }, extra)).status).toBe(200);
		expect(await keyOfLastCall(harness.mock)).toBe("key-agent-a");
		expect(harness.resolved).toEqual(["agent-a", "agent-a"]);
		const [first, second] = harness.mock.calls.map(call => call.options?.sessionId);
		expect(first).not.toBe(second);
	});

	it("answers 401 to an admission that carried no Authorization bearer", async () => {
		harness = await boot(req =>
			req.headers.get("x-api-key") === "token-a" ? { kind: "agent", agentAccountId: "agent-a" } : null,
		);
		const response = await chat(harness, { "x-api-key": "token-a" }, {}, "/v1/chat/completions?k=token-a");
		expect(response.status).toBe(401);
		expect(harness.resolved).toEqual([]);
	});

	it("keeps healthz and CORS preflight outside the authorizer", async () => {
		let calls = 0;
		harness = await boot(req => {
			calls++;
			return agentAuthorizer(req);
		});
		expect((await fetch(`${harness.handle.url}/healthz`)).status).toBe(200);
		expect((await fetch(`${harness.handle.url}/v1/models`, { method: "OPTIONS" })).status).toBe(204);
		expect(calls).toBe(0);
	});

	it("routes each agent's chat to its own credential pool, through an async authorizer", async () => {
		harness = await boot(async req => agentAuthorizer(req));
		harness.mock.push({ content: ["a"] });
		harness.mock.push({ content: ["b"] });
		expect((await chat(harness, { Authorization: "Bearer token-a" })).status).toBe(200);
		expect(await keyOfLastCall(harness.mock)).toBe("key-agent-a");
		expect((await chat(harness, { Authorization: "Bearer token-b" })).status).toBe(200);
		expect(await keyOfLastCall(harness.mock)).toBe("key-agent-b");
	});

	it("routes pi-native requests to the caller's pool under caller-scoped cache keys", async () => {
		harness = await boot(agentAuthorizer);
		harness.mock.push({ content: ["a"] });
		harness.mock.push({ content: ["b"] });
		expect((await piNative(harness, "token-a")).status).toBe(200);
		expect((await piNative(harness, "token-b")).status).toBe(200);
		expect(await keyOfLastCall(harness.mock)).toBe("key-agent-b");
		const [first, second] = harness.mock.calls.map(call => call.options);
		expect(first?.promptCacheKey).not.toBe("shared-cache");
		expect(first?.promptCacheKey).not.toBe(second?.promptCacheKey);
		expect(first?.sessionId).not.toBe(second?.sessionId);
	});

	it("lists only the caller's own credentials", async () => {
		harness = await boot(agentAuthorizer);
		expect(await checkedProviders(harness, "token-a")).toEqual(["pool-agent-a"]);
		expect(await checkedProviders(harness, "token-b")).toEqual(["pool-agent-b"]);
	});

	it("sends a non-chat route upstream with the caller's own key", async () => {
		harness = await boot(agentAuthorizer);
		const response = await fetch(`${harness.handle.url}/v1/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer token-b" },
			body: JSON.stringify({ model: "text-embedding-3-small", input: "hi" }),
		});
		expect(response.status).toBe(200);
		expect(harness.upstreamKeys).toEqual(["Bearer key-agent-b"]);
	});

	it("gives two agents sending the same session key distinct provider sessions", async () => {
		harness = await boot(agentAuthorizer);
		harness.mock.push({ content: ["a"] });
		harness.mock.push({ content: ["b"] });
		const extra = { prompt_cache_key: "same-key" };
		expect((await chat(harness, { Authorization: "Bearer token-a" }, extra)).status).toBe(200);
		expect((await chat(harness, { Authorization: "Bearer token-b" }, extra)).status).toBe(200);
		const [first, second] = harness.mock.calls.map(call => call.options?.sessionId);
		expect(first).toBeString();
		expect(second).toBeString();
		expect(first).not.toBe(second);
	});

	it("keeps a shared-token caller's session key verbatim", async () => {
		harness = await boot(bearerTokenAuthorizer(["shared-token"]), false);
		harness.mock.push({ content: ["ok"] });
		const extra = { prompt_cache_key: "client-key" };
		expect((await chat(harness, { Authorization: "Bearer shared-token" }, extra)).status).toBe(200);
		expect(harness.mock.calls[0]?.options?.sessionId).toBe("client-key");
	});

	it("answers 503 without logging the error text when the authorizer fails", async () => {
		harness = await boot(() => {
			throw new Error("verify RPC down: token-a");
		});
		const log = captureWarnings();
		try {
			const response = await chat(harness, { Authorization: "Bearer token-a" });
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("token-a");
		} finally {
			log.dispose();
		}
		expect(log.events.some(event => event.message === "auth-gateway authorizer failed")).toBe(true);
		expect(JSON.stringify(log.events)).not.toContain("token-a");
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("answers 503 when the caller's pool cannot be resolved", async () => {
		harness = await boot(() => ({ kind: "agent", agentAccountId: "agent-unknown" }));
		const response = await chat(harness, { Authorization: "Bearer token-a" });
		expect(response.status).toBe(503);
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("serves the model catalog without resolving a pool", async () => {
		harness = await boot(agentAuthorizer);
		const response = await fetch(`${harness.handle.url}/v1/models`, { headers: { Authorization: "Bearer token-a" } });
		expect(response.status).toBe(200);
		expect(harness.resolved).toEqual([]);
	});

	it("rejects the admitting bearer when it is echoed outside Authorization", async () => {
		harness = await boot(agentAuthorizer);
		const response = await chat(harness, { Authorization: "Bearer token-a" }, {}, "/v1/chat/completions?k=token-a");
		expect(response.status).toBe(400);
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("keeps the shared storage when no per-caller pool is configured", async () => {
		harness = await boot(bearerTokenAuthorizer(["shared-token"]), false);
		harness.mock.push({ content: ["ok"] });
		expect((await chat(harness, { Authorization: "Bearer shared-token" })).status).toBe(200);
		expect(await keyOfLastCall(harness.mock)).toBe("key-shared");
		expect((await chat(harness, { Authorization: "Bearer token-a" })).status).toBe(401);
	});

	it("admits every request when the shared token set is empty", async () => {
		harness = await boot(bearerTokenAuthorizer([]), false);
		harness.mock.push({ content: ["ok"] });
		const response = await chat(harness, {}, {}, "/v1/chat/completions?k=anything");
		expect(response.status).toBe(200);
	});
});
