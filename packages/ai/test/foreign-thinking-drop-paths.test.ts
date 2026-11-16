import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * RIG-10349 review r288-1: every production path that reaches a Claude target
 * must drop foreign or unsigned thinking under `foreignThinkingReplay: "drop"`.
 * These cover the Bedrock encoder, an unsigned block from an Anthropic-compatible
 * source turn, and a thinking-only GPT turn followed by a user turn.
 */
const FOREIGN = "FOREIGN-REASONING-PAYLOAD";
const VISIBLE = "VISIBLE-ANSWER";

const userTurn: UserMessage = { role: "user", content: "continue", timestamp: 0 };
const nextUser: UserMessage = { role: "user", content: "next", timestamp: 2 };

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function gptTurn(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function claudeBedrock(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		name: "Claude Sonnet 4.5 (Bedrock)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as ModelSpec<"bedrock-converse-stream">);
}

function claudeAnthropic(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<"anthropic-messages">);
}

/** A non-Claude Anthropic-compatible source (for example Kimi): unsigned thinking on `anthropic-messages`. */
function anthropicCompatSourceTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: FOREIGN, thinkingSignature: "" },
			{ type: "text", text: VISIBLE },
		],
		api: "anthropic-messages",
		provider: "kimi",
		model: "kimi-k2",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

const ANTHROPIC_EMPTY_MESSAGE = [
	{
		type: "message_start",
		message: {
			id: "m1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

function captureFetch(bodies: unknown[]): FetchImpl {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = url.includes("/messages") ? ANTHROPIC_EMPTY_MESSAGE : "data: [DONE]\n\n";
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

describe("foreignThinkingReplay drop: Bedrock Claude (review r288-1 #3)", () => {
	it("drops an unsigned foreign thinking block from the Bedrock wire for a Claude id", async () => {
		const context: Context = {
			messages: [
				userTurn,
				gptTurn([
					{ type: "thinking", thinking: FOREIGN, thinkingSignature: "" },
					{ type: "text", text: VISIBLE },
				]),
				nextUser,
			],
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const controller = new AbortController();
		controller.abort();
		void streamBedrock(claudeBedrock(), context, {
			bearerToken: "test-token",
			signal: controller.signal,
			maxTokens: 16,
			foreignThinkingReplay: "drop",
			onPayload: payload => resolve(payload),
		});
		const wire = JSON.stringify(await promise);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).toContain(VISIBLE);
	});
});

describe("foreignThinkingReplay drop: documented alias limit (docs/settings.md)", () => {
	it("keeps demotion for an opaque Bedrock ARN, whose id hides the Claude class", async () => {
		const arnModel = buildModel({
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/company-claude",
			name: "Opaque profile",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} as ModelSpec<"bedrock-converse-stream">);
		const context: Context = {
			messages: [
				userTurn,
				gptTurn([
					{ type: "thinking", thinking: FOREIGN, thinkingSignature: "" },
					{ type: "text", text: VISIBLE },
				]),
				nextUser,
			],
		};
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<unknown>();
		void streamBedrock(arnModel, context, {
			bearerToken: "test-token",
			signal: controller.signal,
			maxTokens: 16,
			foreignThinkingReplay: "drop",
			onPayload: payload => resolve(payload),
		});
		const wire = JSON.stringify(await promise);
		expect(wire).toContain(FOREIGN);
	});
});

describe("foreignThinkingReplay drop: Anthropic-compatible source turn (review r288-1 #5)", () => {
	it("drops unsigned thinking from a non-Claude anthropic-messages source for a Claude target", async () => {
		const bodies: unknown[] = [];
		await streamSimple(
			claudeAnthropic(),
			{ messages: [userTurn, anthropicCompatSourceTurn(), nextUser] },
			{
				apiKey: "k",
				fetch: captureFetch(bodies),
				foreignThinkingReplay: "drop",
			},
		).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).toContain(VISIBLE);
	});
});

describe("foreignThinkingReplay drop: thinking-only GPT turn (review r288-1 #6)", () => {
	it("keeps a valid Anthropic body when a thinking-only GPT turn is followed by a user turn", async () => {
		const bodies: unknown[] = [];
		await streamSimple(
			claudeAnthropic(),
			{
				messages: [
					userTurn,
					gptTurn([{ type: "thinking", thinking: FOREIGN, thinkingSignature: "rs_opaque" }]),
					nextUser,
				],
			},
			{ apiKey: "k", fetch: captureFetch(bodies), foreignThinkingReplay: "drop" },
		).result();
		const wire = bodies[0] as { messages: Array<{ role: string }> };
		expect(JSON.stringify(wire)).not.toContain(FOREIGN);
		// The thinking-only assistant turn is removed; both user turns remain as a valid body.
		expect(wire.messages.map(message => message.role)).toEqual(["user", "user"]);
	});
});

/** A non-signing anthropic-messages Claude host: a proxy, so the signing endpoint check is false. */
function claudeNonSigningHost(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "litellm",
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (proxy)",
		baseUrl: "https://llm-proxy.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as ModelSpec<"anthropic-messages">);
}

describe("foreignThinkingReplay drop: native replay on a non-signing Claude host (review r288-2 M2)", () => {
	it("sends no foreign thinking as text or native block for a GPT source turn", async () => {
		const bodies: unknown[] = [];
		await streamSimple(
			claudeNonSigningHost(),
			{
				messages: [
					userTurn,
					gptTurn([
						{ type: "thinking", thinking: FOREIGN, thinkingSignature: "" },
						{ type: "text", text: VISIBLE },
					]),
					nextUser,
				],
			},
			{ apiKey: "k", fetch: captureFetch(bodies), foreignThinkingReplay: "drop" },
		).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).toContain(VISIBLE);
	});

	it("still replays same-model signed thinking natively under drop", async () => {
		const SIGNED = "SAME-MODEL-SIGNED-REASONING";
		const sameModelTurn: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: SIGNED, thinkingSignature: "sig_same_model" },
				{ type: "text", text: VISIBLE },
			],
			api: "anthropic-messages",
			provider: "litellm",
			model: "claude-sonnet-4-5",
			usage: usage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const bodies: unknown[] = [];
		await streamSimple(
			claudeNonSigningHost(),
			{ messages: [userTurn, sameModelTurn, nextUser] },
			{ apiKey: "k", fetch: captureFetch(bodies), foreignThinkingReplay: "drop" },
		).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).toContain(SIGNED);
		expect(wire).toContain("sig_same_model");
	});
});

/** Opus on the same non-signing proxy as {@link claudeNonSigningHost}: same provider, not official, no prefix binding. */
function opusNonSigningHost(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "litellm",
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5 (proxy)",
		baseUrl: "https://llm-proxy.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as ModelSpec<"anthropic-messages">);
}

describe("foreignThinkingReplay drop: Claude source on a non-signing proxy (review r288-4 medium)", () => {
	it("keeps signed Sonnet thinking natively when replayed to Opus on the same proxy under drop", async () => {
		const SIGNED = "SONNET-SIGNED-REASONING";
		const sonnetTurn: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: SIGNED, thinkingSignature: "sig_sonnet" },
				{ type: "text", text: VISIBLE },
			],
			api: "anthropic-messages",
			provider: "litellm",
			model: "claude-sonnet-4-5",
			usage: usage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const bodies: unknown[] = [];
		await streamSimple(
			opusNonSigningHost(),
			{ messages: [userTurn, sonnetTurn, nextUser] },
			{ apiKey: "k", fetch: captureFetch(bodies), foreignThinkingReplay: "drop" },
		).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).toContain(SIGNED);
		expect(wire).toContain("sig_sonnet");
	});

	it("drops GPT-signed thinking replayed to Opus on the same proxy under drop", async () => {
		const bodies: unknown[] = [];
		await streamSimple(
			opusNonSigningHost(),
			{
				messages: [
					userTurn,
					gptTurn([
						{ type: "thinking", thinking: FOREIGN, thinkingSignature: "rs_gpt" },
						{ type: "text", text: VISIBLE },
					]),
					nextUser,
				],
			},
			{ apiKey: "k", fetch: captureFetch(bodies), foreignThinkingReplay: "drop" },
		).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).not.toContain("rs_gpt");
		expect(wire).toContain(VISIBLE);
	});
});
