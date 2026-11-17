/**
 * RIG-10540: when a chat credential is blocked, or the upstream reports a usage
 * limit, the gateway routes answer 429 (with `Retry-After` when the block end is
 * known) instead of a 500 that LiteLLM would forward as an outage.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { bearerTokenAuthorizer, type CandidateFailoverOptions, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { scheduler } from "node:timers/promises";

const PROVIDER = "openai-codex";
const MODEL: Model<"openai-codex-responses"> = buildModel({
	id: "gpt-6-luna",
	name: "gpt-6-luna",
	api: "openai-codex-responses",
	provider: PROVIDER,
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});
const GATEWAY_TOKEN = "gateway-blocked-429-token";
const OAUTH_ACCESS = "codex-oauth-access-blocked-429";
const BLOCK_MS = 10 * 60_000;
const PI_CONTEXT = { messages: [{ role: "user", content: "Hi", timestamp: 1 }] };

interface GatewayFixture {
	url: string;
	close(): Promise<void>;
}

interface GatewayOptions {
	/** Puts the credential into a broker chat block before the request. */
	readonly block?: boolean;
	/** Candidate failover; with it set, `next` decides whether a follower exists. */
	readonly candidateFailover?: CandidateFailoverOptions;
}

/**
 * A gateway with one stored Codex OAuth credential. `upstreamMessage` is thrown
 * on each call the gateway makes to the provider.
 */
async function startGateway(upstreamMessage: string, options: GatewayOptions = {}): Promise<GatewayFixture> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await storage.credentials.set(PROVIDER, [
		{
			type: "oauth",
			access: OAUTH_ACCESS,
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60_000,
			accountId: "blocked-account",
		},
	]);
	const fetchUpstream: FetchImpl = async () => {
		throw new Error(upstreamMessage);
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer([GATEWAY_TOKEN]),
		storage,
		resolveModel: (): Model<Api> => MODEL,
		version: "test",
		fetch: fetchUpstream,
		...(options.candidateFailover && { candidateFailover: options.candidateFailover }),
	});
	if (options.block) {
		const row = storage.credentials.list(PROVIDER).find(entry => entry.credential.type === "oauth");
		if (!row) throw new Error("OAuth credential missing from test storage");
		storage.blocks.upsert({
			credentialId: row.id,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "chat",
			blockedUntilMs: Date.now() + BLOCK_MS,
		});
	}
	return {
		url: handle.url,
		close: async () => {
			await handle.close();
			storage.close();
		},
	};
}

function sendChat(url: string): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: MODEL.id, messages: [{ role: "user", content: "Hi" }], stream: false }),
	});
}

function sendPiNative(url: string): Promise<Response> {
	return fetch(`${url}/v1/pi/stream`, {
		method: "POST",
		headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ modelId: MODEL.id, context: PI_CONTEXT, stream: false }),
	});
}

/**
 * The provider's retry wait is real time; stubbing it keeps each retry instant so the
 * cases run under bun's default timeout. Restored after every case.
 */
let waitSpy: Mock<typeof scheduler.wait>;
beforeEach(() => {
	waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
});
afterEach(() => {
	waitSpy.mockRestore();
});

describe("auth-gateway: a usage cap answers 429 (RIG-10540)", () => {
	it("answers chat 429 with Retry-After when the blocked credential's upstream reports the cap", async () => {
		// A blocked sole credential stays a last-resort candidate (routing is unchanged), so the
		// request reaches upstream and the cap it reports is the answer. Its retry hint sets Retry-After.
		const gateway = await startGateway("You have hit your ChatGPT usage limit. retry-after-ms=600000", {
			block: true,
		});
		try {
			const response = await sendChat(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("600");
			expect(body).toContain("rate_limit_error");
		} finally {
			await gateway.close();
		}
	});

	it("answers chat 429 when the upstream throws a usage limit that carries an embedded 5xx status", async () => {
		const gateway = await startGateway("HTTP 500: usage_limit_reached");
		try {
			const response = await sendChat(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(body).toContain("rate_limit_error");
			expect(body).not.toContain("internal error");
		} finally {
			await gateway.close();
		}
	});

	it("keeps a non-usage upstream error at its existing status, never 429", async () => {
		const gateway = await startGateway("HTTP 500: decoder exploded");
		try {
			const response = await sendChat(gateway.url);

			expect(response.status).toBe(500);
		} finally {
			await gateway.close();
		}
	});

	it("answers 429 on the candidate-failover path when no follower can take the usage limit", async () => {
		// With failover configured, a thrown usage limit goes through judgeAttempt and serveWithFailover.
		// No follower exists, so the 429 answer and its Retry-After header reach the client.
		const gateway = await startGateway("HTTP 500: usage_limit_reached retry-after-ms=120000", {
			candidateFailover: {
				next: async () => undefined,
				onFailure: () => {},
			},
		});
		try {
			const response = await sendChat(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("120");
			expect(body).toContain("rate_limit_error");
		} finally {
			await gateway.close();
		}
	});

	it("answers 429 on the pi-native non-stream route for a usage limit with an embedded 5xx", async () => {
		const gateway = await startGateway("HTTP 500: usage_limit_reached retry-after-ms=60000");
		try {
			const response = await sendPiNative(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("60");
			expect(body).toContain("rate_limit_error");
		} finally {
			await gateway.close();
		}
	});
});
