import { expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AssignmentLineage, assignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
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
		expect(events).toEqual(["snapshot"]);
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
		let signals = 0;
		advisory.subscribe(event => { if (event.type === "signal") signals++; });
		advisory.signal("tool-repeat", 3);
		lineage.terminal("child", second.assignmentId);
		advisory.signal("tool-repeat", 3);
		expect(signals).toBe(1);
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
		vi.advanceTimersByTime(300_000);
		expect(send).toHaveBeenCalledTimes(1);
		expect(admitTaskAdvisory(parent, message, message.advisoryBinding)).toBe("reject");
		expect(admitTaskAdvisory(parent, { ...message, body: "changed" }, message.advisoryBinding)).toBe("reject");
		expect(admitTaskAdvisory(parent, message, { ...message.advisoryBinding, requestId: "unknown" })).toBe("reject");
		receiveTaskAdvisory(parent, message);
		expect(admitTaskAdvisory(parent, message, message.advisoryBinding)).toBe("duplicate");
		gate.resolve({ outcome: "injected" });
		expect((await pending).outcome).toBe("injected");
		vi.advanceTimersByTime(600_000);
		expect(replies).toEqual(["check"]);
		expect(send).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 64; index++) await advisory.remind(ref, `extra-${index}`, "request");
		expect((await advisory.remind(ref, "check", "request")).outcome).toBe("duplicate");
		expect(admitTaskAdvisory(parent, message, message.advisoryBinding)).toBe("reject");
		lineage.terminal("race-child", ref.assignmentId);
		vi.advanceTimersByTime(600_000);
		expect(send).toHaveBeenCalledTimes(65);
	} finally { dispose(); send.mockRestore(); vi.useRealTimers(); AgentRegistry.resetGlobalForTests(); }
});

it("reattaches a parked parent and expires it on release", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const lineage = assignmentLineage;
	const parentId = crypto.randomUUID();
	const childId = crypto.randomUUID();
	const makeParent = () => { let disposer = () => {}; return { sessionManager: { getSessionId: () => parentId, getUsageStatistics: () => ({ cost: 0, subagentCost: 0 }) }, subscribe: () => () => {}, addDisposer: (fn: () => void) => { disposer = fn; }, dispose: async () => { disposer(); } } as unknown as AgentSession; };
	const parent = makeParent();
	const child = { sessionManager: { getSessionId: () => childId }, deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	registry.register({ id: "ParkParent", displayName: "Parent", kind: "sub", session: parent, status: "idle" });
	registry.register({ id: "ParkChild", displayName: "Child", kind: "sub", parentId: "ParkParent", session: child });
	lineage.attach(parentId, "old");
	const ref = lineage.mint(childId, parentId);
	lineage.attach(childId, "child");
	lifecycle.adopt("ParkParent", { idleTtlMs: 0, revive: async () => { const revived = makeParent(); lineage.attach(parentId, "new"); return revived; } });
	try {
		await lifecycle.park("ParkParent");
		const revived = await lifecycle.ensureLive("ParkParent");
		const advisory = createTaskAdvisory(revived, lineage);
		expect((await advisory.remind(ref, "revived-check", "progress")).outcome).toBe("injected");
		await lifecycle.park("ParkParent");
		expect(vi.getTimerCount()).toBe(0);
		await lifecycle.release("ParkParent");
		expect(vi.getTimerCount()).toBe(0);
		expect(lineage.children(parentId)).toEqual([]);
		expect(await advisory.remind(ref, "expired-check", "progress")).toMatchObject({ outcome: "unavailable", reason: "parent-gone" });
	} finally {
		await lifecycle.dispose();
		lineage.disposeSession(childId, "child");
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	}
});