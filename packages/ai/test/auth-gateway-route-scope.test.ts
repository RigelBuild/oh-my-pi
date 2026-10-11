import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, spyOn } from "bun:test";
import { createAuthGatewayRouter, SHARED_TOKEN_CALLER } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	type AuthCredential,
	type AuthCredentialStore,
	type CredentialRefreshLeaseFence,
	type StoredAuthCredential,
	AuthStorage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

class RecordingCredentialStore extends SqliteAuthCredentialStore implements AuthCredentialStore {
	readonly readScopes: (string | undefined)[] = [];
	readonly writeScopes: (string | undefined)[] = [];
	readonly updatedAccessTokens: string[] = [];

	constructor(
		db: Database,
		private readonly scope: AsyncLocalStorage<string>,
	) {
		super(db);
	}

	override listAuthCredentials(provider?: string): StoredAuthCredential[] {
		this.readScopes.push(this.scope.getStore());
		return super.listAuthCredentials(provider);
	}

	override tryUpdateAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean {
		this.writeScopes.push(this.scope.getStore());
		if (credential.type === "oauth") this.updatedAccessTokens.push(credential.access);
		return super.tryUpdateAuthCredentialIfMatches(id, expectedData, credential, lease);
	}
}

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function anthropicSuccessResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_route_scope",
				model: anthropicModel.id,
				role: "assistant",
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function anthropicUnauthorizedResponse(): Response {
	return Response.json(
		{ type: "error", error: { type: "authentication_error", message: "expired access token" } },
		{ status: 401 },
	);
}

describe("auth-gateway route scope", () => {
	it("keeps route scope through storage resolution and storage reads", async () => {
		const scope = new AsyncLocalStorage<string>();
		const store = new RecordingCredentialStore(new Database(":memory:"), scope);
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.set("route-scope-test", { type: "api_key", key: "stored-key" });
		store.readScopes.length = 0;
		const resolvedScopes: (string | undefined)[] = [];
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => undefined,
			resolveStorage: () => {
				resolvedScopes.push(scope.getStore());
				return storage;
			},
			routeScope: (req, run) => scope.run("request-context", run),
		});

		try {
			const response = await router.route(
				new Request("http://gateway/v1/credentials/check"),
				"test-peer",
				SHARED_TOKEN_CALLER,
			);

			expect(response.status).toBe(200);
			expect(resolvedScopes).toEqual(["request-context"]);
			expect(store.readScopes).toContain("request-context");
		} finally {
			router.close();
			storage.close();
		}
	});

	it("keeps route scope for a streaming OAuth refresh after route returns", async () => {
		const scope = new AsyncLocalStorage<string>();
		const store = new RecordingCredentialStore(new Database(":memory:"), scope);
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.set("anthropic", {
			type: "oauth",
			access: "initial-access",
			refresh: "initial-refresh",
			expires: Date.now() + 60 * 60_000,
			accountId: "route-scope-account",
			email: "route-scope@example.test",
		});
		store.writeScopes.length = 0;
		store.updatedAccessTokens.length = 0;

		const firstUpstreamResponse = Promise.withResolvers<Response>();
		let routeReturned = false;
		let upstreamCalls = 0;
		const upstreamFetch: FetchImpl = async () => {
			upstreamCalls += 1;
			if (upstreamCalls === 1) {
				const response = await firstUpstreamResponse.promise;
				expect(routeReturned).toBe(true);
				return response;
			}
			return anthropicSuccessResponse();
		};
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => anthropicModel,
			fetch: upstreamFetch,
			routeScope: (_req, run) => scope.run("initiating-request", run),
		});
		let refreshRequests = 0;
		const refreshFetch: typeof fetch = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
				expect(String(input)).toBe("https://api.anthropic.com/v1/oauth/token");
				refreshRequests += 1;
				return Response.json({
					access_token: "refreshed-access",
					refresh_token: "refreshed-refresh",
					expires_in: 3600,
					account: { uuid: "route-scope-account", email_address: "route-scope@example.test" },
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const refreshFetchSpy = spyOn(globalThis, "fetch").mockImplementation(refreshFetch);

		try {
			const response = await router.route(
				new Request("http://gateway/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: anthropicModel.id,
						max_tokens: 16,
						messages: [{ role: "user", content: "hello" }],
						stream: true,
					}),
				}),
				"test-peer",
				SHARED_TOKEN_CALLER,
			);
			routeReturned = true;
			firstUpstreamResponse.resolve(anthropicUnauthorizedResponse());
			await response.text();

			expect(response.status).toBe(200);
			expect(upstreamCalls).toBe(2);
			expect(refreshRequests).toBe(1);
			expect(store.updatedAccessTokens).toContain("refreshed-access");
			expect(store.writeScopes).toContain("initiating-request");
		} finally {
			refreshFetchSpy.mockRestore();
			router.close();
			storage.close();
		}
	});

	it("answers 500 when route scope throws", async () => {
		const scope = new AsyncLocalStorage<string>();
		const storage = new AuthStorage(new RecordingCredentialStore(new Database(":memory:"), scope));
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => undefined,
			routeScope: async () => {
				throw new Error("scope failed");
			},
		});

		try {
			const response = await router.route(
				new Request("http://gateway/v1/unknown"),
				"test-peer",
				SHARED_TOKEN_CALLER,
			);

			expect(response.status).toBe(500);
		} finally {
			router.close();
			storage.close();
		}
	});
});
