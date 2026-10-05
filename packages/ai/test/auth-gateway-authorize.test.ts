import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type AuthGatewayAuthorizer,
	type AuthGatewayServerHandle,
	bearerTokenAuthorizer,
	type CallerIdentity,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

interface Harness {
	handle: AuthGatewayServerHandle;
	mock: MockModel;
	pools: Map<string, AuthStorage>;
	resolved: string[];
	close(): Promise<void>;
}

const AGENT_TOKENS: Record<string, string> = { "token-a": "agent-a", "token-b": "agent-b" };

/** Stands in for the verify RPC: one token per agent account. */
const agentAuthorizer: AuthGatewayAuthorizer = req => {
	const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
	const agentAccountId = token ? AGENT_TOKENS[token] : undefined;
	return agentAccountId ? { agentAccountId } : null;
};

async function boot(authorize: AuthGatewayAuthorizer, perAgentPools = true): Promise<Harness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-authorize-"));
	const shared = await AuthStorage.create(path.join(dir, "shared.db"));
	shared.keys.setRuntime("openrouter", "key-shared");
	const pools = new Map<string, AuthStorage>();
	for (const agent of ["agent-a", "agent-b"]) {
		const pool = await AuthStorage.create(path.join(dir, `${agent}.db`));
		pool.keys.setRuntime("openrouter", `key-${agent}`);
		pools.set(agent, pool);
	}
	const resolved: string[] = [];
	const mock = createMockModel({ provider: "openrouter", id: "mock/authorize" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize,
		storage: shared,
		resolveStorage: perAgentPools
			? (caller: CallerIdentity) => {
					resolved.push(caller.agentAccountId);
					const pool = pools.get(caller.agentAccountId);
					if (!pool) throw new Error(`no pool for ${caller.agentAccountId}`);
					return pool;
				}
			: undefined,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		handle,
		mock,
		pools,
		resolved,
		close: async () => {
			await handle.close();
			shared.close();
			for (const pool of pools.values()) pool.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function chat(harness: Harness, headers: Record<string, string>, url = "/v1/chat/completions"): Promise<Response> {
	return fetch(`${harness.handle.url}${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ model: "mock/authorize", messages: [{ role: "user", content: "hi" }], stream: false }),
	});
}

function apiKeyOfLastCall(mock: MockModel): unknown {
	return mock.calls.at(-1)?.options?.apiKey;
}

async function resolvedKey(apiKey: unknown): Promise<unknown> {
	if (typeof apiKey !== "function") return apiKey;
	const resolved: unknown = await apiKey({ lastChance: false });
	return resolved && typeof resolved === "object" && "apiKey" in resolved ? resolved.apiKey : resolved;
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

	it("routes each agent to its own credential pool", async () => {
		harness = await boot(agentAuthorizer);
		harness.mock.push({ content: ["a"] });
		harness.mock.push({ content: ["b"] });
		expect((await chat(harness, { Authorization: "Bearer token-a" })).status).toBe(200);
		expect(await resolvedKey(apiKeyOfLastCall(harness.mock))).toBe("key-agent-a");
		expect((await chat(harness, { Authorization: "Bearer token-b" })).status).toBe(200);
		expect(await resolvedKey(apiKeyOfLastCall(harness.mock))).toBe("key-agent-b");
		expect(harness.resolved).toEqual(["agent-a", "agent-b"]);
	});

	it("scopes non-chat routes to the caller's pool too", async () => {
		harness = await boot(agentAuthorizer);
		const usage = await fetch(`${harness.handle.url}/v1/credentials/check`, {
			headers: { Authorization: "Bearer token-b" },
		});
		expect(usage.status).toBe(200);
		expect(harness.resolved).toEqual(["agent-b"]);
	});

	it("answers 503, not 401, when the authorizer itself fails", async () => {
		harness = await boot(() => {
			throw new Error("verify RPC down: token-a");
		});
		const response = await chat(harness, { Authorization: "Bearer token-a" });
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("token-a");
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("rejects the admitting bearer when it is echoed outside Authorization", async () => {
		harness = await boot(agentAuthorizer);
		const response = await chat(harness, { Authorization: "Bearer token-a" }, "/v1/chat/completions?k=token-a");
		expect(response.status).toBe(400);
		expect(harness.mock.calls).toHaveLength(0);
	});

	it("keeps the shared storage when no per-caller pool is configured", async () => {
		harness = await boot(bearerTokenAuthorizer(["shared-token"]), false);
		harness.mock.push({ content: ["ok"] });
		expect((await chat(harness, { Authorization: "Bearer shared-token" })).status).toBe(200);
		expect(await resolvedKey(apiKeyOfLastCall(harness.mock))).toBe("key-shared");
		expect((await chat(harness, { Authorization: "Bearer token-a" })).status).toBe(401);
	});

	it("admits every request when the shared token set is empty", async () => {
		harness = await boot(bearerTokenAuthorizer([]), false);
		harness.mock.push({ content: ["ok"] });
		const response = await chat(harness, { Authorization: "Bearer anything" }, "/v1/chat/completions?k=anything");
		expect(response.status).toBe(200);
	});
});
