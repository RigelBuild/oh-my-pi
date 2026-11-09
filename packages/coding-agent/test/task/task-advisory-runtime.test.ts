import { expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AssignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import { admitTaskAdvisory, createTaskAdvisory, receiveTaskAdvisory } from "@oh-my-pi/pi-coding-agent/task/task-advisory-runtime";

it("emits snapshots only when their values change", () => {
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let emit: (event: AgentSessionEvent) => void = () => {};
	const session = {
		sessionManager: { getSessionId: () => "child" },
		subscribe: (listener: typeof emit) => { emit = listener; return () => {}; },
		addDisposer: () => {},
	} as unknown as AgentSession;
	const clock = spyOn(performance, "now").mockReturnValue(10);
	try {
		const events: string[] = [];
		createTaskAdvisory(session, lineage).subscribe(event => events.push(event.type));
		emit({ type: "agent_start" });
		emit({ type: "model_changed" });
		expect(events).toEqual(["snapshot"]);
		clock.mockReturnValue(20);
		emit({ type: "model_changed" });
		expect(events).toEqual(["snapshot", "snapshot"]);
	} finally { clock.mockRestore(); }
});


it("starts a fresh baseline after reassignment", () => {
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	const first = lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let emit: (event: AgentSessionEvent) => void = () => {};
	const session = {
		sessionManager: { getSessionId: () => "child" },
		subscribe: (listener: typeof emit) => { emit = listener; return () => {}; },
		addDisposer: () => {},
	} as unknown as AgentSession;
	const clock = spyOn(performance, "now").mockReturnValue(0);
	try {
		const advisory = createTaskAdvisory(session, lineage);
		emit({ type: "agent_start" });
		clock.mockReturnValue(100);
		expect(advisory.current()?.wallMs).toBe(100);
		const second = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		expect(advisory.current()).toBeUndefined();
		emit({ type: "agent_start" });
		clock.mockReturnValue(125);
		expect(advisory.current()).toMatchObject({ ref: second, wallMs: 25, workTokens: null });
		expect(second.assignmentId).not.toBe(first.assignmentId);
	} finally { clock.mockRestore(); }
});

it("closes a reply watch before reminder delivery resolves", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	const lineage = new AssignmentLineage();
	lineage.attach("race-parent", "parent-instance");
	const ref = lineage.mint("race-child", "race-parent");
	lineage.attach("race-child", "child-instance");
	let dispose = () => {};
	const parent = { sessionManager: { getSessionId: () => "race-parent" }, subscribe: () => () => {}, addDisposer: (fn: () => void) => { dispose = fn; } } as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => "race-child" } } as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({ id: "RaceParent", displayName: "Parent", kind: "sub", session: parent });
	registry.register({ id: "RaceChild", displayName: "Child", kind: "sub", session: child });
	const gate = Promise.withResolvers<{ outcome: "injected" }>();
	const send = spyOn(IrcBus.global(), "sendBound").mockImplementation(() => gate.promise);
	try {
		const advisory = createTaskAdvisory(parent, lineage);
		const replies: string[] = [];
		advisory.subscribe(event => { if (event.type === "reply") replies.push(event.requestId); });
		expect((await advisory.remind(ref, "é".repeat(65), "request")).outcome).toBe("unavailable");
		expect((await advisory.remind(ref, "check", "é".repeat(2049))).outcome).toBe("unavailable");
		const pending = advisory.remind(ref, "check", "request");
		const message = { id: "message", ts: 0, from: "RaceChild", to: "RaceParent", body: "progress", advisoryBinding: { ref, branchId: ref.parentBranchId, senderInstanceId: "child-instance", recipientInstanceId: "parent-instance", requestId: "check" } };
		expect(admitTaskAdvisory(parent, message, message.advisoryBinding)).toBe("accept");
		expect(admitTaskAdvisory(parent, message, message.advisoryBinding)).toBe("duplicate");
		expect(admitTaskAdvisory(parent, { ...message, body: "changed" }, message.advisoryBinding)).toBe("reject");
		expect(admitTaskAdvisory(parent, message, { ...message.advisoryBinding, requestId: "unknown" })).toBe("reject");
		receiveTaskAdvisory(parent, message);
		gate.resolve({ outcome: "injected" });
		expect((await pending).outcome).toBe("injected");
		vi.advanceTimersByTime(600_000);
		expect(replies).toEqual(["check"]);
		expect(send).toHaveBeenCalledTimes(1);
	} finally { dispose(); send.mockRestore(); vi.useRealTimers(); AgentRegistry.resetGlobalForTests(); }
});