import { afterEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { IrcBridge } from "../../src/session/irc-bridge";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { AdvisoryHub } from "../../src/task/advisory-hub";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

afterEach(() => {
	AdvisoryHub.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});
for (const stale of [false, true]) {
	it(
		stale
			? "drops a stranded advisory after wake remints its assignment"
			: "delivers a child advisory to the next model call",
		async () => {
			const hub = AdvisoryHub.main();
			const registry = AgentRegistry.global();
			hub.attach({ sessionId: "parent", instanceId: "p", agentId: "Parent" });
			const ref = hub.mint({
				childSessionId: "child",
				parentSessionId: "parent",
				messaging: { status: "supported" },
			});
			hub.attach({ sessionId: "child", instanceId: "c", agentId: "Child" });
			let observed = 0;
			const bridge = new IrcBridge({
				agent: {} as never,
				sessionManager: {} as never,
				isDisposed: () => false,
				isStreaming: () => true,
				planModeEnabled: () => false,
				emitSessionEvent: async () => {
					observed++;
				},
				wakeForIrc: () => {},
			});
			registry.register({
				id: "Parent",
				displayName: "Parent",
				kind: "sub",
				session: {
					deliverIrcMessage: (message: Parameters<IrcBridge["deliver"]>[0]) => bridge.deliver(message),
				} as unknown as AgentSession,
			});
			registry.register({
				id: "Child",
				displayName: "Child",
				kind: "sub",
				parentId: "Parent",
				session: {} as AgentSession,
			});
			const body = JSON.stringify({
				state: "progressing",
				progress: "PRIVATE_ADVISORY",
				tried: [],
				blocker: "",
				nextAction: "continue",
			});
			expect(
				(
					await hub.sendBound({
						childSessionId: "child",
						fromAgentId: "Child",
						toAgentId: "Parent",
						assignmentId: ref.assignmentId,
						body,
					})
				).outcome,
			).toBe("injected");
			const queued = bridge.drainPending();
			expect(queued).toHaveLength(1);
			expect(observed).toBe(0);
			if (stale) {
				hub.terminal("child", ref.assignmentId);
				hub.wake("child");
			}
			let request = "";
			const mock = createMockModel({
				handler: context => {
					request = JSON.stringify(context.messages);
					return { content: ["done"] };
				},
			});
			const auth = createInMemoryAuthStorage();
			auth.keys.setRuntime("mock", "test-key");
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: queued },
					convertToLlm,
					streamFn: mock.stream,
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(auth),
			});
			try {
				await session.prompt("continue");
				expect(request).toContain("continue");
				if (stale) expect(request).not.toContain("PRIVATE_ADVISORY");
				else expect(request).toContain("PRIVATE_ADVISORY");
			} finally {
				await session.dispose();
				auth.close();
				hub.detach("child", "c");
				hub.detach("parent", "p");
			}
		},
	);
}
