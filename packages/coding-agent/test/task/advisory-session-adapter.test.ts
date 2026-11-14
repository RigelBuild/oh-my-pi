import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { advisoryEventOf } from "../../src/task/advisory-session-adapter";
import { AdvisorySnapshotSource } from "../../src/task/advisory-snapshot-source";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";

const source = new AdvisorySnapshotSource();
const events: Array<[AgentSessionEvent, number]> = [
	[{ type: "agent_start" } as AgentSessionEvent, 0],
	[{ type: "tool_execution_start", toolCallId: "first", toolName: "ask", args: {} } as AgentSessionEvent, 10],
	[{ type: "tool_execution_start", toolCallId: "second", toolName: "edit", args: {} } as AgentSessionEvent, 20],
	[
		{
			type: "tool_execution_end",
			toolCallId: "first",
			toolName: "ask",
			result: { content: [] },
			isError: false,
		} as AgentSessionEvent,
		30,
	],
	[{ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "retry" }, 40],
	[{ type: "auto_compaction_start", reason: "threshold", action: "context-full" }, 50],
	[{ type: "auto_retry_end", success: true, attempt: 1 }, 60],
	[{ type: "auto_compaction_end", action: "context-full", result: undefined, aborted: false, willRetry: false }, 70],
	[{ type: "agent_start" } as AgentSessionEvent, 80],
	[{ type: "message_persisted", id: "assistant-1", usage: { input: 3, output: 2 } }, 90],
	[{ type: "message_persisted", id: "assistant-1", usage: { input: 3, output: 2 } }, 100],
	[
		{
			type: "tool_execution_end",
			toolCallId: "second",
			toolName: "edit",
			result: { content: [] },
			isError: false,
		} as AgentSessionEvent,
		110,
	],
];

test("maps lifecycle events and the source handles repeated readiness and usage ids once", () => {
	for (const [event, at] of events) {
		const mapped = advisoryEventOf(event, at);
		if (mapped) source.accept(mapped);
		if (at === 30) expect(source.snapshot(40)).toMatchObject({ unblockedMs: 10, waitReasons: ["tool"] });
	}
	expect(source.snapshot(120)).toEqual({
		wallMs: 120,
		unblockedMs: 20,
		waitReasons: [],
		workTokens: 5,
		usagePartial: false,
	});
});

test("ignores unrelated session events", () => {
	expect(advisoryEventOf({ type: "model_changed" }, 1)).toBeUndefined();
});

test("real session emits one persisted identity", async () => {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const manager = SessionManager.inMemory();
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	const snapshot = new AdvisorySnapshotSource();
	const ids: string[] = [];
	try {
		session.subscribe(event => {
			const mapped = advisoryEventOf(event, performance.now());
			if (mapped) snapshot.accept(mapped);
			if (event.type === "message_persisted") {
				ids.push(event.id);
				if (mapped) snapshot.accept(mapped);
			}
		});
		await session.prompt("hello");
		expect(ids).toHaveLength(1);
		expect(manager.getEntries().some(entry => entry.id === ids[0])).toBe(true);
		expect(snapshot.snapshot(performance.now())).toBeDefined();
	} finally {
		await session.dispose();
		auth.close();
	}
});
