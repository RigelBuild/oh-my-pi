import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AutoLearnController } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildCaptureDigest, createAutoLearnCaptureRunner } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";

const manageSkill: AgentTool = {
	name: "manage_skill",
	label: "manage_skill",
	description: "Manage reusable skills",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text", text: "captured" }] }),
};

async function seatWithHistory(provider = "anthropic") {
	const seat = createMockModel({ id: "seat-model", provider, responses: [{ content: ["Primary answer."] }] });
	const sourceAgent = new Agent({
		initialState: {
			model: seat,
			systemPrompt: ["Primary system prompt"],
			tools: [manageSkill],
			thinkingLevel: Effort.Low,
		},
		convertToLlm,
		streamFn: seat.stream,
	});
	await sourceAgent.prompt("Earlier task");
	return { seat, sourceAgent };
}

afterEach(() => vi.restoreAllMocks());

describe("auto-learn capture target", () => {
	it("keeps today's request when no capture setting is set", async () => {
		const { seat, sourceAgent } = await seatWithHistory();
		seat.push({ content: ["Nothing to keep."] });
		const run = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkill],
			createAgent: options => new Agent({ ...options, convertToLlm, streamFn: seat.stream }),
			resolveCaptureTarget: () => undefined,
		});
		await run("Automated capture prompt");
		expect(seat.calls).toHaveLength(2);
		const capture = seat.calls[1];
		expect(capture?.context.systemPrompt).toEqual(["Primary system prompt"]);
		expect(capture?.context.tools?.map(tool => tool.name)).toEqual(["manage_skill"]);
		expect(capture?.options?.reasoning).toBe(Effort.Low);
		expect(capture?.options?.disableReasoning).toBe(false);
		// The seat history (user, assistant) followed by the capture nudge as a user message.
		expect(capture?.context.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	});

	it("runs on the role's model and thinking level with reasoning enabled", async () => {
		const { seat, sourceAgent } = await seatWithHistory();
		const role = createMockModel({ id: "luna", provider: "luna", responses: [{ content: ["Kept."] }] });
		const run = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkill],
			createAgent: options => new Agent({ ...options, convertToLlm, streamFn: role.stream }),
			resolveCaptureTarget: () => ({ model: role, thinkingLevel: Effort.High }),
		});
		await run("Automated capture prompt");
		expect(seat.calls).toHaveLength(1);
		expect(role.calls).toHaveLength(1);
		expect(role.calls[0]?.options?.disableReasoning).toBe(false);
		expect(role.calls[0]?.options?.reasoning).toBe(Effort.High);
	});

	it("accepts replayed Anthropic-seat history on another provider's role", async () => {
		const { sourceAgent } = await seatWithHistory("anthropic");
		const role = createMockModel({ id: "luna", provider: "luna", responses: [{ content: ["Kept."] }] });
		const run = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkill],
			createAgent: options => new Agent({ ...options, convertToLlm, streamFn: role.stream }),
			resolveCaptureTarget: () => ({ model: role, thinkingLevel: Effort.Medium }),
		});
		await run("Automated capture prompt");
		const roles = role.calls[0]?.context.messages.map(message => message.role);
		expect(roles).toContain("assistant");
		expect(roles?.[0]).toBe("user");
	});

	it("skips capture and sends nothing to the seat when the role cannot resolve", async () => {
		const { seat, sourceAgent } = await seatWithHistory();
		let created = 0;
		const run = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkill],
			createAgent: options => {
				created++;
				return new Agent({ ...options, convertToLlm, streamFn: seat.stream });
			},
			resolveCaptureTarget: () => null,
		});
		await run("Automated capture prompt");
		expect(created).toBe(0);
		expect(seat.calls).toHaveLength(1);
	});

	it("skips capture when capturePrompt is unreadable", async () => {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const captures: string[] = [];
		const warned = Promise.withResolvers<string>();
		vi.spyOn(logger, "warn").mockImplementation((message: string) => warned.resolve(message));
		const session = {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			getPlanModeState: () => undefined,
			getGoalModeState: () => undefined,
		};
		new AutoLearnController({
			session: session as unknown as AgentSession,
			settings: Settings.isolated({
				"autolearn.enabled": true,
				"autolearn.autoContinue": true,
				"autolearn.minToolCalls": 0,
				"autolearn.capturePrompt": path.join(os.tmpdir(), `missing-${Snowflake.next()}.md`),
			}),
			capture: async content => {
				captures.push(content);
			},
		});
		for (const listener of listeners) listener({ type: "agent_end", messages: [] });
		expect(await warned.promise).toContain("capturePrompt is unreadable");
		expect(captures).toEqual([]);
	});

	it("sends one digest request within captureMaxInputTokens for a 400k-token source", async () => {
		const seat = createMockModel({ id: "seat-model", provider: "anthropic", responses: [] });
		const filler = "word ".repeat(16_000);
		const messages: AgentMessage[] = [{ role: "user", content: "First ask", timestamp: 1 }];
		for (let i = 0; i < 100; i++) {
			messages.push({
				role: "assistant",
				api: seat.api,
				provider: seat.provider,
				model: seat.id,
				content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: {} }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2 + i,
			});
			messages.push({
				role: "toolResult",
				toolCallId: `c${i}`,
				toolName: "read",
				content: [{ type: "text", text: filler }],
				isError: false,
				timestamp: 2 + i,
			});
		}
		const tokenizer = new Tokenizer(seat);
		expect(tokenizer.countMessages(messages)).toBeGreaterThan(400_000);
		const cap = 50_000;
		const sourceAgent = new Agent({
			initialState: { model: seat, systemPrompt: ["Primary system prompt"], tools: [manageSkill], messages },
			convertToLlm,
			streamFn: seat.stream,
		});
		seat.push({ content: ["Kept."] });
		const run = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: () => [manageSkill],
			createAgent: options => new Agent({ ...options, convertToLlm, streamFn: seat.stream }),
			maxInputTokens: cap,
		});
		await run("Automated capture prompt");
		expect(seat.calls).toHaveLength(1);
		const sent = seat.calls[0]?.context.messages ?? [];
		const sentTokens =
			tokenizer.countTokens(seat.calls[0]?.context.systemPrompt ?? []) +
			sent.reduce((sum, message) => sum + tokenizer.countMessage(message as AgentMessage), 0);
		expect(sentTokens).toBeLessThanOrEqual(cap);
		expect(sent[0]?.role).toBe("user");
		// Tail cut on whole tool groups: no tool result without its call.
		const firstAfterHead = sent[1];
		expect(firstAfterHead?.role).not.toBe("toolResult");
	});

	it("digest keeps the first user message, latest compaction summary and whole tail groups", () => {
		const messages = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "compactionSummary", summary: "old", tokensBefore: 1, timestamp: 2 },
			{ role: "compactionSummary", summary: "new", tokensBefore: 1, timestamp: 3 },
			{ role: "assistant", content: [], timestamp: 4 },
			{ role: "toolResult", toolCallId: "a", content: [], timestamp: 5 },
			{ role: "assistant", content: [], timestamp: 6 },
			{ role: "toolResult", toolCallId: "b", content: [], timestamp: 7 },
		] as unknown as AgentMessage[];
		const digest = buildCaptureDigest(messages, 5, () => 1);
		expect(digest.map(message => message.timestamp)).toEqual([1, 3, 6, 7]);
	});
});
