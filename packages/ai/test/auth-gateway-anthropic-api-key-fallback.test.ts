import { expect, test } from "bun:test";
import { bearerTokenAuthorizer, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const PROVIDER = "anthropic";
const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: PROVIDER,
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});
const API_KEY = "sk-ant-api03-test";
const OAUTH_ACCESS = "sk-ant-oat-test-oauth";
const GATEWAY_TOKEN = "gateway-test-token";

interface UpstreamRequest {
	url: string;
	headers: Headers;
}

interface GatewayFixture {
	url: string;
	storage: AuthStorage;
	close(): Promise<void>;
}

function anthropicSuccessResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_api_key_fallback",
				model: MODEL.id,
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

async function startGateway(
	credentials: Array<
		| { type: "oauth"; access: string; refresh: string; expires: number; accountId: string }
		| { type: "api_key"; key: string; source?: "login" }
	>,
	fetchUpstream: FetchImpl,
): Promise<GatewayFixture> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await storage.credentials.set(PROVIDER, credentials);
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer([GATEWAY_TOKEN]),
		storage,
		resolveModel: (_id): Model<Api> => MODEL,
		version: "test",
		fetch: fetchUpstream,
	});
	return {
		url: handle.url,
		storage,
		close: async () => {
			await handle.close();
			storage.close();
		},
	};
}

function gatewayFetch(requests: UpstreamRequest[], respond: () => Response): FetchImpl {
	return async (input, init) => {
		requests.push({
			url: input instanceof Request ? input.url : String(input),
			headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
		});
		return respond();
	};
}

async function sendChat(url: string): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content: "Hi" }], stream: false }),
	});
}

withOfficialAnthropicEndpoint();

test("uses an unblocked stored api_key instead of blocked OAuth and sends official Anthropic headers", async () => {
	const requests: UpstreamRequest[] = [];
	const fixture = await startGateway(
		[
			{
				type: "oauth",
				access: OAUTH_ACCESS,
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60_000,
				accountId: "blocked",
			},
			{ type: "api_key", key: API_KEY },
		],
		gatewayFetch(requests, anthropicSuccessResponse),
	);
	try {
		const oauth = fixture.storage.credentials.list(PROVIDER).find(row => row.credential.type === "oauth");
		if (!oauth) throw new Error("OAuth credential missing from test storage");
		fixture.storage.blocks.upsert({
			credentialId: oauth.id,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "",
			blockedUntilMs: Date.now() + 60 * 60_000,
		});
		expect(await fixture.storage.keys.get(PROVIDER, "blocked-oauth-fallback-proof")).toBe(API_KEY);

		const response = await sendChat(fixture.url);
		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(requests[0]?.headers.get("x-api-key")).toBe(API_KEY);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(requests[0]?.headers.get("anthropic-beta") ?? "").not.toContain("oauth-2025-04-20");
	} finally {
		await fixture.close();
	}
});

test("uses unblocked OAuth ahead of a stored api_key", async () => {
	const requests: UpstreamRequest[] = [];
	const fixture = await startGateway(
		[
			{
				type: "oauth",
				access: OAUTH_ACCESS,
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60_000,
				accountId: "available",
			},
			{ type: "api_key", key: API_KEY },
		],
		gatewayFetch(requests, anthropicSuccessResponse),
	);
	try {
		const response = await sendChat(fixture.url);
		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${OAUTH_ACCESS}`);
		expect(requests[0]?.headers.get("x-api-key")).toBeNull();
		expect(requests[0]?.headers.get("anthropic-beta") ?? "").toContain("oauth-2025-04-20");
	} finally {
		await fixture.close();
	}
});

test("rotates to a stored api_key when the only OAuth credential hits a usage limit", async () => {
	const requests: UpstreamRequest[] = [];
	const fixture = await startGateway(
		[
			{
				type: "oauth",
				access: OAUTH_ACCESS,
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60_000,
				accountId: "limited",
			},
			{ type: "api_key", key: API_KEY },
		],
		gatewayFetch(requests, () =>
			requests.length === 1
				? Response.json(
						{
							type: "error",
							error: { type: "rate_limit_error", message: "usage limit reached" },
						},
						{ status: 429, headers: { "x-should-retry": "false" } },
					)
				: anthropicSuccessResponse(),
		),
	);
	try {
		const response = await sendChat(fixture.url);
		expect(response.status).toBe(200);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${OAUTH_ACCESS}`);
		expect(requests[1]?.headers.get("x-api-key")).toBe(API_KEY);
		expect(requests[1]?.headers.get("authorization")).toBeNull();
	} finally {
		await fixture.close();
	}
});

test("keeps a hint-less generic Anthropic usage-limit block short", async () => {
	const requests: UpstreamRequest[] = [];
	const fixture = await startGateway(
		[{ type: "api_key", key: API_KEY }],
		gatewayFetch(requests, () =>
			Response.json(
				{ type: "error", error: { type: "rate_limit_error", message: "usage limit reached" } },
				{ status: 429, headers: { "x-should-retry": "false" } },
			),
		),
	);
	try {
		const response = await sendChat(fixture.url);
		await response.text();

		const apiKeyRow = fixture.storage.credentials
			.list(PROVIDER)
			.find(row => row.credential.type === "api_key" && row.credential.key === API_KEY);
		expect(apiKeyRow).toBeDefined();
		if (!apiKeyRow) throw new Error("API-key credential missing after usage-limit response");
		const block = fixture.storage.blocks
			.list([apiKeyRow.id])
			.find(item => item.providerKey === `${PROVIDER}:api_key`);
		expect(block).toBeDefined();
		if (!block) throw new Error("API-key usage-limit block missing");
		expect(block.blockedUntilMs).toBeGreaterThan(Date.now());
		expect(block.blockedUntilMs).toBeLessThan(Date.now() + 5 * 60_000);
		expect(requests).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("blocks an Anthropic api_key after credit exhaustion without deleting it", async () => {
	const requests: UpstreamRequest[] = [];
	const fixture = await startGateway(
		[{ type: "api_key", key: API_KEY }],
		gatewayFetch(requests, () =>
			Response.json(
				{
					type: "error",
					error: {
						type: "invalid_request_error",
						message:
							"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
					},
				},
				{ status: 400 },
			),
		),
	);
	try {
		const response = await sendChat(fixture.url);
		await response.text();

		const apiKeyRow = fixture.storage.credentials
			.list(PROVIDER)
			.find(row => row.credential.type === "api_key" && row.credential.key === API_KEY);
		expect(apiKeyRow).toBeDefined();
		if (!apiKeyRow) throw new Error("API-key credential was deleted after credit exhaustion");
		const blocks = fixture.storage.blocks.list([apiKeyRow.id]);
		// A drained balance refills only by purchase, so the block outlasts the one-minute default.
		expect(
			blocks.some(
				block => block.providerKey === `${PROVIDER}:api_key` && block.blockedUntilMs > Date.now() + 10 * 60_000,
			),
		).toBe(true);
		expect(requests).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});
