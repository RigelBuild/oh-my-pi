import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * RIG-10349: a GPT turn carries reasoning that Claude cannot verify. With
 * `thinking.foreignReplay: "drop"` that reasoning is removed for Claude targets
 * instead of being demoted to visible text. Other targets keep demotion.
 * Asserts on the outgoing request body, not on encoder internals.
 */
const THINKING = "FOREIGN-GPT-REASONING-TEXT";
const VISIBLE = "VISIBLE-ANSWER";

import { streamSimple } from "@oh-my-pi/pi-ai";

/** Production path: settings → streamSimple → mapOptionsForApi → provider. */
describe("foreignThinkingReplay via streamSimple (production path)", () => {
	it("Claude over the Anthropic API: a drop set on SimpleStreamOptions reaches the wire", async () => {
		const bodies: unknown[] = [];
		await streamSimple(claudeAnthropic(), context, {
			apiKey: "k",
			fetch: captureFetch(bodies),
			foreignThinkingReplay: "drop",
		}).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).not.toContain(THINKING);
		expect(wire).toContain(VISIBLE);
	});

	it("Claude id through an OpenAI-compatible gateway: a drop set on SimpleStreamOptions reaches the wire", async () => {
		const bodies: unknown[] = [];
		await streamSimple(claudeLiteLLM(), context, {
			apiKey: "k",
			fetch: captureFetch(bodies),
			foreignThinkingReplay: "drop",
		}).result();
		const wire = JSON.stringify(bodies[0]);
		expect(wire).not.toContain(THINKING);
		expect(wire).toContain(VISIBLE);
	});
});

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

function claudeLiteLLM(): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		provider: "litellm",
		id: "claude-sonnet-4-5",
		name: "Claude via LiteLLM",
		baseUrl: "http://127.0.0.1:4000/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<"openai-completions">);
}

function llamaCpp(): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		provider: "llama.cpp",
		id: "llama-3-local",
		name: "Local llama",
		baseUrl: "http://127.0.0.1:8080/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<"openai-completions">);
}

const userTurn: UserMessage = { role: "user", content: "continue", timestamp: 0 };

/** A GPT assistant turn: foreign thinking (OpenAI-minted signature), then visible text. */
function gptTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING, thinkingSignature: "rs_gpt_opaque_signature" },
			{ type: "text", text: VISIBLE },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const context: Context = { messages: [userTurn, gptTurn(), { role: "user", content: "next", timestamp: 1 }] };

/** A complete minimal Anthropic message stream, so the SDK resolves instead of retrying. */
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

/** Captures the outgoing request body and answers with an empty successful stream. */
function captureFetch(bodies: unknown[]): FetchImpl {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = url.includes("/messages") ? ANTHROPIC_EMPTY_MESSAGE : "data: [DONE]\n\n";
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

async function anthropicWire(
	model: Model<"anthropic-messages">,
	foreignThinkingReplay?: "demote" | "drop",
): Promise<string> {
	const bodies: unknown[] = [];
	await streamAnthropic(model, context, {
		apiKey: "k",
		fetch: captureFetch(bodies),
		foreignThinkingReplay,
	}).result();
	return JSON.stringify(bodies[0]);
}

async function completionsWire(
	model: Model<"openai-completions">,
	foreignThinkingReplay?: "demote" | "drop",
): Promise<string> {
	const bodies: unknown[] = [];
	await streamOpenAICompletions(model, context, {
		apiKey: "k",
		fetch: captureFetch(bodies),
		foreignThinkingReplay,
	}).result();
	return JSON.stringify(bodies[0]);
}

describe("foreignThinkingReplay", () => {
	it("Claude over the Anthropic API: drop removes foreign thinking from the wire", async () => {
		const wire = await anthropicWire(claudeAnthropic(), "drop");
		expect(wire).not.toContain(THINKING);
		expect(wire).toContain(VISIBLE);
	});

	it("Claude id through an OpenAI-compatible gateway: drop removes foreign thinking from the wire", async () => {
		const wire = await completionsWire(claudeLiteLLM(), "drop");
		expect(wire).not.toContain(THINKING);
		expect(wire).toContain(VISIBLE);
	});

	it("default demote keeps the foreign thinking as text for a Claude target", async () => {
		const wire = await anthropicWire(claudeAnthropic());
		expect(wire).toContain(THINKING);
	});

	it("drop leaves a non-Claude target demoted: llama.cpp still carries the thinking", async () => {
		const wire = await completionsWire(llamaCpp(), "drop");
		expect(wire).toContain(THINKING);
	});
});
