import { describe, expect, it } from "bun:test";
import { streamOpenAIAnthropicShim } from "../src/providers/openai-anthropic-shim";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { AssistantMessage, Context, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type CapturedRequest,
	captureFetch,
	anthropicChunks,
	factoryModel,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

/** RIG-10349 review r288-2 H1: wrapper providers must carry the drop to the Claude request. */
const FOREIGN = "FOREIGN-REASONING-PAYLOAD";
const VISIBLE = "VISIBLE-ANSWER";

const userTurn: UserMessage = { role: "user", content: "continue", timestamp: 0 };
const nextUser: UserMessage = { role: "user", content: "next", timestamp: 1 };

/** A GPT assistant turn: foreign thinking first, then visible text. */
function gptTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: FOREIGN, thinkingSignature: "" },
			{ type: "text", text: VISIBLE },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

const context: Context = { messages: [userTurn, gptTurn(), nextUser] };

/** OpenRouter Claude: the catalog proves this pair Claude-class (classifier-cot-extraction). */
const claudeOverShim = buildModel({
	id: "anthropic/claude-opus-4.5",
	name: "Claude Opus 4.5",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as ModelSpec<"openai-completions">);

describe("foreignThinkingReplay drop: wrapper providers (review r288-2 H1)", () => {
	it("openai-anthropic shim: drop reaches the Claude request body", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const stream = streamOpenAIAnthropicShim(
			claudeOverShim,
			context,
			{
				apiKey: "test-key",
				foreignThinkingReplay: "drop",
				onPayload: body => {
					resolve(body);
					throw new Error("stop after payload capture");
				},
			},
			{ anthropicBaseUrl: "https://shim.example/anthropic", defaultFormat: "anthropic" },
		);
		await stream.result();
		const wire = JSON.stringify(await promise);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).toContain(VISIBLE);
	});

	it("factory droid messages wire: drop reaches the Claude request body", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			factoryModel("claude-sonnet-4-5-20250929"),
			{ messages: [userTurn, gptTurn(), nextUser] },
			{
				apiKey: WORKOS_TOKEN,
				foreignThinkingReplay: "drop",
				fetch: captureFetch(captured, anthropicChunks("OK")),
			},
		).result();
		const wire = JSON.stringify(captured[0]?.body);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).toContain(VISIBLE);
	});

	it("openai-anthropic shim completions route: drop reaches the request body", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const stream = streamOpenAIAnthropicShim(
			claudeOverShim,
			context,
			{
				apiKey: "test-key",
				foreignThinkingReplay: "drop",
				onPayload: body => {
					resolve(body);
					throw new Error("stop after payload capture");
				},
			},
			{ anthropicBaseUrl: "https://shim.example/anthropic", defaultFormat: "openai" },
		);
		await stream.result();
		const wire = JSON.stringify(await promise);
		expect(wire).not.toContain(FOREIGN);
		expect(wire).toContain(VISIBLE);
	});
});
