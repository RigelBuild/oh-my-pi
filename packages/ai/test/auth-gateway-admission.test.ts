import { afterEach, describe, expect, it } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	hashAuthGatewayToken,
	type AuthGatewayClient,
	type AuthGatewayServerHandle,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

const CLIENT_TOKEN = "scoped-client-token";
const CLIENT: AuthGatewayClient = {
	name: "scoped",
	tokenSha256: hashAuthGatewayToken(CLIENT_TOKEN),
	models: ["mock/allowed"],
};

let gateway: AuthGatewayServerHandle | undefined;
let storage: AuthStorage | undefined;

afterEach(async () => {
	await gateway?.close();
	gateway = undefined;
	storage?.close();
	storage = undefined;
	clearCustomApis();
});

describe("auth-gateway client admission", () => {
	it("keeps a matched client scoped under a permissive custom authorizer", async () => {
		registerMockApi();
		storage = await AuthStorage.create(":memory:");
		storage.keys.setRuntime("mock", "mock-key");
		const allowed = createMockModel({ provider: "mock", id: "allowed" });
		allowed.push({ content: ["ok"] });
		const denied = createMockModel({ provider: "mock", id: "denied" });
		let authorizerCalls = 0;
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			authorize: () => {
				authorizerCalls++;
				return { kind: "agent", agentAccountId: "permissive" };
			},
			storage,
			clients: [CLIENT],
			resolveModel: id => (id === "mock/allowed" ? allowed : id === "mock/denied" ? denied : undefined),
		});
		const request = (token: string, model: string) =>
			fetch(`${gateway!.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
			});

		expect((await request(CLIENT_TOKEN, "mock/allowed")).status).toBe(200);
		expect((await request(CLIENT_TOKEN, "mock/denied")).status).toBe(404);
		expect(authorizerCalls).toBe(0);
	});

	it("falls an unknown token through to the injected authorizer", async () => {
		storage = await AuthStorage.create(":memory:");
		let authorizerCalls = 0;
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			authorize: req => {
				authorizerCalls++;
				return req.headers.get("authorization") === "Bearer custom-token"
					? { kind: "agent", agentAccountId: "custom" }
					: null;
			},
			storage,
			clients: [CLIENT],
			resolveModel: () => undefined,
		});
		const response = await fetch(`${gateway.url}/v1/models`, {
			headers: { Authorization: "Bearer custom-token" },
		});
		expect(response.status).toBe(200);
		expect(authorizerCalls).toBe(1);
	});

	it("returns 503 when the fallback authorizer throws", async () => {
		storage = await AuthStorage.create(":memory:");
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			authorize: () => {
				throw new Error("verification unavailable");
			},
			storage,
			clients: [CLIENT],
			resolveModel: () => undefined,
		});
		const response = await fetch(`${gateway.url}/v1/models`, {
			headers: { Authorization: "Bearer unknown-token" },
		});
		expect(response.status).toBe(503);
	});
});
