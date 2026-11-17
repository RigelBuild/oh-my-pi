/**
 * RIG-10540: when a chat credential is blocked, or the upstream reports a usage
 * limit, the gateway routes answer 429 (with `Retry-After` when the block end is
 * known) instead of a 500 that LiteLLM would forward as an outage.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { bearerTokenAuthorizer, type CandidateFailoverOptions, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, AssistantMessage, Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { scheduler } from "node:timers/promises";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

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

/** A custom api whose answer sets both error fields to different text, as the cursor provider does. */
const SPLIT_API = "auth-gateway-blocked-429-split";
const SPLIT_MODEL_ID = "split-error-model";
const SPLIT_CLIENT_TEXT = "Connect error invalid_argument: tools[3].parameters is not an object";
const SPLIT_CLASSIFICATION_TEXT = "You have hit your ChatGPT usage limit. retry-after-ms=60000";

interface GatewayFixture {
	url: string;
	close(): Promise<void>;
}

interface GatewayOptions {
	/** Puts the credential into a broker chat block before the request. */
	readonly block?: boolean;
	/** Candidate failover; with it set, `next` decides whether a follower exists. */
	readonly candidateFailover?: CandidateFailoverOptions;
	/** Answers the upstream call with a response instead of throwing; the answered branch. */
	readonly respond?: () => Response;
	/** Throws this error from the upstream call instead of a message-only `Error`, so its headers reach the gateway. */
	readonly throwError?: Error;
	/** Routes every request to this model instead of the Codex model. */
	readonly model?: Model<Api>;
}

/**
 * A gateway with one stored Codex OAuth credential. By default each upstream
 * call throws `upstreamMessage`; with `respond` it returns that response instead.
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
		if (options.respond) return options.respond();
		if (options.throwError) throw options.throwError;
		throw new Error(upstreamMessage);
	};
	const routed = options.model ?? MODEL;
	if (routed.provider !== PROVIDER) storage.keys.setRuntime(routed.provider, "test-key");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer([GATEWAY_TOKEN]),
		storage,
		resolveModel: (): Model<Api> => routed,
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

/** A Codex usage cap returned as an HTTP response, so the gateway takes the answered-error branch. */
function codexUsageCapResponse(): Response {
	return new Response(
		JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }),
		{ status: 500, headers: { "content-type": "application/json", "retry-after-ms": "90000" } },
	);
}

/** A 402 out-of-credit answer: the account needs a top-up, which waiting never clears. */
function outOfCreditResponse(): Response {
	return new Response(JSON.stringify({ error: { type: "insufficient_quota", message: "out of credit" } }), {
		status: 402,
		headers: { "content-type": "application/json" },
	});
}

/** Anthropic's prepaid-balance 400, which a top-up clears. */
function creditBalanceTooLowResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				type: "invalid_request_error",
				message:
					"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/**
 * Registers a custom api whose terminal error sets `errorMessage` (client text) and
 * `errorClassificationMessage` (the classifier's text) to different strings.
 */
function registerSplitErrorApi(): Model<Api> {
	registerCustomApi(SPLIT_API, (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
		const stream = new AssistantMessageEventStream();
		const failure: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: SPLIT_CLIENT_TEXT,
			errorClassificationMessage: SPLIT_CLASSIFICATION_TEXT,
			timestamp: Date.now(),
			duration: 0,
		};
		stream.push({ type: "start", partial: failure });
		stream.push({ type: "error", reason: "error", error: failure });
		return stream;
	});
	return buildModel({
		id: SPLIT_MODEL_ID,
		name: SPLIT_MODEL_ID,
		api: SPLIT_API as Api,
		provider: "split-provider",
		baseUrl: "https://split.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	}) as Model<Api>;
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
	clearCustomApis();
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

	it("answers chat 429 with the client error text when the upstream answers a usage cap with a 5xx", async () => {
		// The answered branch: the 429 body carries the upstream error message, not its classification text.
		const gateway = await startGateway("", { respond: codexUsageCapResponse });
		try {
			const response = await sendChat(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("90");
			expect(body).toContain("rate_limit_error");
			expect(body).toContain("You have hit your ChatGPT usage limit");
		} finally {
			await gateway.close();
		}
	});

	it("answers chat 429 with errorMessage, not errorClassificationMessage, when the two differ", async () => {
		// The split fixture puts the usage text only in the classifier field, so the 429 comes from the
		// usage check and the body must carry the client text (`errorMessage`), not the classifier text.
		const splitModel = registerSplitErrorApi();
		const gateway = await startGateway("", { model: splitModel });
		try {
			const response = await sendChat(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(body).toContain(SPLIT_CLIENT_TEXT);
			expect(body).not.toContain(SPLIT_CLASSIFICATION_TEXT);
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

	it("answers 429 with the client error text on the pi-native answered branch", async () => {
		const gateway = await startGateway("", { respond: codexUsageCapResponse });
		try {
			const response = await sendPiNative(gateway.url);
			const body = await response.text();

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("90");
			expect(body).toContain("You have hit your ChatGPT usage limit");
		} finally {
			await gateway.close();
		}
	});

	it("keeps a 402 out-of-credit answer at 402, not 429", async () => {
		// A billing cap is cleared by topping up, so waiting never helps: it must not become a retry-able 429.
		// A real 402 is a non-2xx response, which the provider turns into a status-carrying error.
		const gateway = await startGateway("", { respond: outOfCreditResponse });
		try {
			const response = await sendChat(gateway.url);

			expect(response.status).toBe(402);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			await gateway.close();
		}
	});

	it("keeps Anthropic's 'credit balance is too low' 400 at 400, not 429", async () => {
		const gateway = await startGateway("", { respond: creditBalanceTooLowResponse });
		try {
			const response = await sendChat(gateway.url);

			expect(response.status).toBe(400);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			await gateway.close();
		}
	});

	it("reads Retry-After from a thrown error's headers when the message carries no hint", async () => {
		// The message has no retry-after-ms text; the only hint is the upstream header on the thrown error.
		const headers = new Headers({ "retry-after-ms": "45000" });
		const error = Object.assign(new Error("The usage limit has been reached"), { status: 500, headers });
		const gateway = await startGateway("", { throwError: error });
		try {
			const response = await sendChat(gateway.url);

			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("45");
		} finally {
			await gateway.close();
		}
	});

	it("keeps a 402 out-of-credit answer at 402 on the pi-native answered branch", async () => {
		const gateway = await startGateway("", { respond: outOfCreditResponse });
		try {
			const response = await sendPiNative(gateway.url);

			expect(response.status).toBe(402);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			await gateway.close();
		}
	});

	it("keeps Anthropic's 'credit balance is too low' 400 at 400 on the pi-native answered branch", async () => {
		const gateway = await startGateway("", { respond: creditBalanceTooLowResponse });
		try {
			const response = await sendPiNative(gateway.url);

			expect(response.status).toBe(400);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			await gateway.close();
		}
	});

	it("keeps a 402 out-of-credit answer at 402 on the candidate-failover path", async () => {
		// The answered message reaches judgeAttempt through the failover loop, and no follower can take it.
		const gateway = await startGateway("", {
			respond: outOfCreditResponse,
			candidateFailover: { next: async () => undefined, onFailure: () => {} },
		});
		try {
			const response = await sendChat(gateway.url);

			expect(response.status).toBe(402);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			await gateway.close();
		}
	});

	it("keeps Anthropic's 'credit balance is too low' 400 at 400 on the candidate-failover path", async () => {
		const gateway = await startGateway("", {
			respond: creditBalanceTooLowResponse,
			candidateFailover: { next: async () => undefined, onFailure: () => {} },
		});
		try {
			const response = await sendChat(gateway.url);

			expect(response.status).toBe(400);
			expect(response.headers.get("retry-after")).toBeNull();
		} finally {
			await gateway.close();
		}
	});
});
