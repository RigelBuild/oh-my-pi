import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * RIG-10349: a GPT turn carries reasoning that Claude cannot verify. With
 * `thinking.foreignReplay: "drop"` that reasoning is removed for Claude targets
 * instead of being demoted to visible text. Other targets keep demotion.
 * Asserts on the outgoing request body, not on encoder internals.
 */
const THINKING = "FOREIGN-GPT-REASONING-TEXT";
const VISIBLE = "VISIBLE-ANSWER";

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

/** A GPT cap error moves the fallback chain to Claude. The Claude request must carry no foreign thinking. */
describe("foreignThinkingReplay across a GPT-to-Claude fallback", () => {
	const USAGE_LIMIT_BODY = JSON.stringify({
		error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "The usage limit has been reached" },
	});

	function gptResponses(): Model<"openai-responses"> {
		return buildModel({
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5",
			name: "GPT-5",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 400_000,
			reasoning: true,
		} as ModelSpec<"openai-responses">);
	}

	/** Answers GPT requests with a usage cap, and Claude requests with an empty successful stream. */
	function capFetch(claudeBodies: unknown[]): FetchImpl {
		async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/messages")) {
				if (typeof init?.body === "string") claudeBodies.push(JSON.parse(init.body));
				return new Response(ANTHROPIC_EMPTY_MESSAGE, { headers: { "content-type": "text/event-stream" } });
			}
			return new Response(USAGE_LIMIT_BODY, {
				status: 429,
				headers: { "content-type": "application/json", "x-should-retry": "false" },
			});
		}
		return Object.assign(mockFetch, { preconnect: fetch.preconnect });
	}

	/** Only the message history, so the `thinking` request config is not mistaken for a thinking block. */
	function claudeMessages(bodies: unknown[]): string {
		const body = bodies[0];
		if (typeof body !== "object" || body === null || !("messages" in body)) {
			throw new Error("Expected a Claude request body with messages");
		}
		return JSON.stringify(body.messages);
	}

	it("a GPT cap error falls back to Claude: drop keeps foreign thinking off the Claude wire", async () => {
		const dropBodies: unknown[] = [];
		const failed = await streamSimple(gptResponses(), context, { apiKey: "k", fetch: capFetch(dropBodies) }).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("usage_limit_reached");

		await streamSimple(claudeAnthropic(), context, {
			apiKey: "k",
			fetch: capFetch(dropBodies),
			foreignThinkingReplay: "drop",
		}).result();
		const dropWire = claudeMessages(dropBodies);
		expect(dropWire).not.toContain(THINKING);
		expect(dropWire).not.toMatch(/"type":"(?:redacted_)?thinking"/);
		expect(dropWire).toContain(VISIBLE);

		// Control: the same fallback with the default demote keeps the sentinel on the wire.
		const controlBodies: unknown[] = [];
		await streamSimple(claudeAnthropic(), context, { apiKey: "k", fetch: capFetch(controlBodies) }).result();
		expect(claudeMessages(controlBodies)).toContain(THINKING);
	});
});
