import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AdvisorySessionAdapter } from "@oh-my-pi/pi-coding-agent/task/advisory-session-adapter";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

test("real session emits persisted identities once and adapter deduplicates them", async () => {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const manager = SessionManager.inMemory();
	const agent = new Agent({ initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] }, streamFn: mock.stream });
	const session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated({ "compaction.enabled": false }), modelRegistry: new ModelRegistry(auth) });
	const adapter = new AdvisorySessionAdapter();
	const ids: string[] = [];
	try {
		session.subscribe(event => {
			adapter.accept(event, performance.now());
			if (event.type === "message_persisted") {
				ids.push(event.id);
				adapter.accept(event, performance.now());
			}
		});
		await session.prompt("hello");
		expect(ids).toHaveLength(1);
		expect(manager.getEntries().some(entry => entry.id === ids[0])).toBe(true);
		expect(adapter.source.snapshot(performance.now())).toBeDefined();
	} finally {
		await session.dispose();
		auth.close();
	}
});

test("tracks overlapping tools, retry, compaction and repeated readiness", () => {
	const adapter = new AdvisorySessionAdapter();
	adapter.accept({ type: "agent_start" }, 0);
	adapter.accept({ type: "tool_execution_start", toolCallId: "first", toolName: "first", args: {} }, 10);
	adapter.accept({ type: "tool_execution_start", toolCallId: "second", toolName: "second", args: {} }, 20);
	adapter.accept({ type: "tool_execution_end", toolCallId: "first", toolName: "first", result: { content: [] }, isError: true }, 30);
	expect(adapter.source.snapshot(40)).toMatchObject({ wallMs: 40, unblockedMs: 10, waitReasons: ["tool"] });
	adapter.accept({ type: "tool_execution_end", toolCallId: "second", toolName: "second", result: { content: [] }, isError: false }, 50);
	adapter.accept({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "retry" }, 60);
	adapter.accept({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }, 70);
	adapter.accept({ type: "auto_retry_end", success: true, attempt: 1 }, 80);
	adapter.accept({ type: "auto_compaction_end", action: "context-full", result: undefined, aborted: false, willRetry: false }, 90);
	adapter.accept({ type: "agent_start" }, 95);
	expect(adapter.source.snapshot(100)).toMatchObject({ wallMs: 100, unblockedMs: 30, waitReasons: [] });
});
