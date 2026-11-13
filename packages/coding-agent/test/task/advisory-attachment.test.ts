import { afterEach, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { IrcBridge } from "../../src/session/irc-bridge";
import { convertToLlm } from "../../src/session/messages";
import { AdvisoryAttachment, taskAdvisoryFor } from "../../src/task/advisory-attachment";
import { AdvisoryHub } from "../../src/task/advisory-hub";

afterEach(() => {
	AdvisoryHub.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("forwards local events, keeps parked snapshots and resets on revival", () => {
	const hub = AdvisoryHub.main();
	let emit: (event: AgentSessionEvent) => void = () => {};
	const parent = {
		sessionManager: { getSessionId: () => "parent" },
		getAgentId: () => "Parent",
		subscribe: () => () => {},
	} as unknown as AgentSession;
	const child = {
		sessionManager: { getSessionId: () => "child" },
		getAgentId: () => "Child",
		subscribe: (fn: typeof emit) => {
			emit = fn;
			return () => {};
		},
	} as unknown as AgentSession;
	const parentAttachment = new AdvisoryAttachment(parent);
	const childAttachment = new AdvisoryAttachment(child);
	try {
		parentAttachment.reset();
		const ref = hub.mint({ childSessionId: "child", parentSessionId: "parent", messaging: { status: "supported" } });
		childAttachment.reset();
		emit({ type: "agent_start" });
		expect(taskAdvisoryFor("parent")?.contractVersion).toBe(1);
		expect(parentAttachment.advisory.children()[0]?.ref).toEqual(ref);
		hub.parkSession("child");
		childAttachment.dispose();
		expect(parentAttachment.advisory.children()[0]?.phase).toBe("paused");
		const revived = new AdvisoryAttachment(child);
		revived.reset();
		emit({ type: "agent_start" });
		expect(parentAttachment.advisory.children()[0]?.ref.assignmentId).not.toBe(ref.assignmentId);
		revived.dispose();
	} finally {
		parentAttachment.dispose();
		childAttachment.dispose();
	}
	expect(taskAdvisoryFor("parent")).toBeUndefined();
});

it("drops both queued directions after wake remints the assignment", async () => {
	const hub = AdvisoryHub.main();
	hub.attach({ sessionId: "parent", instanceId: "p", agentId: "Parent" });
	const ref = hub.mint({ childSessionId: "child", parentSessionId: "parent", messaging: { status: "supported" } });
	hub.attach({ sessionId: "child", instanceId: "c", agentId: "Child" });
	const makeBridge = () =>
		new IrcBridge({
			agent: {} as never,
			sessionManager: {} as never,
			isDisposed: () => false,
			isStreaming: () => true,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
		});
	const parentBridge = makeBridge();
	const childBridge = makeBridge();
	const registry = AgentRegistry.global();
	registry.register({
		id: "Parent",
		displayName: "Parent",
		kind: "sub",
		session: {
			deliverIrcMessage: (message: Parameters<IrcBridge["deliver"]>[0]) => parentBridge.deliver(message),
		} as unknown as AgentSession,
	});
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		parentId: "Parent",
		session: {
			deliverIrcMessage: (message: Parameters<IrcBridge["deliver"]>[0]) => childBridge.deliver(message),
		} as unknown as AgentSession,
	});
	const body = JSON.stringify({
		state: "progressing",
		progress: "secret-reply-A",
		tried: [],
		blocker: "",
		nextAction: "continue",
		requestId: "check",
	});
	expect(
		(await hub.remind({ parentSessionId: "parent", ref, requestId: "check", content: "secret-reminder-A" })).outcome,
	).toBe("injected");
	expect(
		(
			await hub.sendBound({
				childSessionId: "child",
				fromAgentId: "Child",
				toAgentId: "Parent",
				assignmentId: ref.assignmentId,
				checkId: "check",
				body,
			})
		).outcome,
	).toBe("injected");
	const queued = [...parentBridge.drainPending(), ...childBridge.drainPending()];
	expect(queued).toHaveLength(2);
	parentBridge.queueAside([queued[0]]);
	childBridge.queueAside([queued[1]]);
	hub.terminal("child", ref.assignmentId);
	hub.wake("child");
	const validate = spyOn(hub, "validate");
	expect(JSON.stringify(convertToLlm(queued))).not.toContain("secret-");
	expect(validate).toHaveBeenCalledTimes(1);
	const records: AgentMessage[] = [...parentBridge.drainPending(), ...childBridge.drainPending()];
	expect(records).toEqual([]);
	expect(validate).toHaveBeenCalledTimes(3);
	validate.mockRestore();
	hub.detach("child", "c");
	hub.detach("parent", "p");
});
