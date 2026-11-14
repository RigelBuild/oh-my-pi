import type { AgentSessionEvent } from "../session/agent-session-events";
import type { AdvisoryEvent } from "./advisory-snapshot-source";

/** Maps lifecycle events to normalized advisory events; unrelated events are ignored. */
export function advisoryEventOf(event: AgentSessionEvent, at: number): AdvisoryEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { kind: "ready", at };
		case "tool_execution_start":
			return {
				kind: "blocked-start",
				at,
				token: `tool:${event.toolCallId}`,
				reason: event.toolName === "ask" ? "ask" : event.toolName === "wait" ? "wait" : "tool",
			};
		case "tool_execution_end":
			return { kind: "blocked-end", at, token: `tool:${event.toolCallId}` };
		case "auto_retry_start":
			return { kind: "blocked-start", at, token: "retry", reason: "retry" };
		case "auto_retry_end":
			return { kind: "blocked-end", at, token: "retry" };
		case "auto_compaction_start":
			return { kind: "blocked-start", at, token: "compaction", reason: "compaction" };
		case "auto_compaction_end":
			return { kind: "blocked-end", at, token: "compaction" };
		case "message_persisted":
			return { kind: "assistant-usage", id: event.id, usage: event.usage };
		default:
			return undefined;
	}
}
