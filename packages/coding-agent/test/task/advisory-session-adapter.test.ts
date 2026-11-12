import { expect, test } from "bun:test";
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
	[
		{ type: "auto_compaction_end", action: "context-full", result: undefined, aborted: false, willRetry: false },
		70,
	],
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
