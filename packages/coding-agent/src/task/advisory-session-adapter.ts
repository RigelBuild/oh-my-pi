import type { AgentSessionEvent } from "../session/agent-session-events";
import { AdvisorySnapshotSource } from "./advisory-snapshot-source";

/** Converts a child session's lifecycle into normalized snapshot events. */
export class AdvisorySessionAdapter {
	readonly source = new AdvisorySnapshotSource();
	#ready = false;

	accept(event: AgentSessionEvent, at: number): void {
		switch (event.type) {
			case "agent_start":
				if (!this.#ready) {
					this.#ready = true;
					this.source.accept({ kind: "ready", at });
				}
				break;
			case "tool_execution_start":
				this.source.accept({ kind: "blocked-start", at, token: `tool:${event.toolCallId}`, reason: event.toolName === "ask" ? "ask" : event.toolName === "wait" ? "wait" : "tool" });
				break;
			case "tool_execution_end":
				this.source.accept({ kind: "blocked-end", at, token: `tool:${event.toolCallId}` });
				break;
			case "auto_retry_start":
				this.source.accept({ kind: "blocked-start", at, token: "retry", reason: "retry" });
				break;
			case "auto_retry_end":
				this.source.accept({ kind: "blocked-end", at, token: "retry" });
				break;
			case "auto_compaction_start":
				this.source.accept({ kind: "blocked-start", at, token: "compaction", reason: "compaction" });
				break;
			case "auto_compaction_end":
				this.source.accept({ kind: "blocked-end", at, token: "compaction" });
				break;
			case "message_persisted":
				this.source.accept({ kind: "assistant-usage", id: event.id, usage: event.usage });
		}
	}
}
