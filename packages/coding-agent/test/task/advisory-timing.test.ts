import { expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AssignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import {
	admitTaskAdvisory,
	createTaskAdvisory,
	rollbackTaskAdvisory,
} from "@oh-my-pi/pi-coding-agent/task/task-advisory-runtime";

it("checks every 15 seconds and sends one follow-up at 300 seconds", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	const ref = lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let dispose = () => {};
	const parent = {
		sessionManager: { getSessionId: () => "parent" },
		subscribe: () => () => {},
		addDisposer: (fn: () => void) => {
			dispose = fn;
		},
	} as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => "child" } } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "TimerParent", displayName: "Parent", kind: "sub", session: parent });
	AgentRegistry.global().register({ id: "TimerChild", displayName: "Child", kind: "sub", session: child });
	const send = spyOn(IrcBus.global(), "sendBound").mockResolvedValue({ outcome: "injected" });
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const current = spyOn(lineage, "isCurrent");
	try {
		const advisory = createTaskAdvisory(parent, lineage);
		send.mockResolvedValueOnce({ outcome: "unavailable", reason: "handoff-failed" });
		expect((await advisory.remind(ref, "retry", "status")).outcome).toBe("unavailable");
		expect((await advisory.remind(ref, "retry", "status")).outcome).toBe("injected");
		const binding = {
			ref,
			branchId: ref.parentBranchId,
			senderInstanceId: "child-instance",
			recipientInstanceId: "parent-instance",
			requestId: "retry",
		};
		const message = {
			id: "reply",
			ts: 0,
			from: "TimerChild",
			to: "TimerParent",
			body: JSON.stringify({
				state: "progressing",
				progress: "worked",
				tried: [],
				blocker: "",
				nextAction: "continue",
				requestId: "retry",
			}),
			advisoryBinding: binding,
		};
		expect(admitTaskAdvisory(parent, message, binding)).toBe("accept");
		expect(vi.getTimerCount()).toBe(0);
		clock.mockReturnValue(290_000);
		rollbackTaskAdvisory(parent, message);
		expect(vi.getTimerCount()).toBe(1);
		clock.mockReturnValue(300_000);
		vi.advanceTimersByTime(10_000);
		expect(send).toHaveBeenCalledTimes(3);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "Reply with a JSON ReportInput via irc send for check retry.",
				assignmentId: ref.assignmentId,
				checkId: "retry",
			}),
			expect.objectContaining({ requestId: "retry" }),
		);
		lineage.terminal("child", ref.assignmentId);
		const next = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		clock.mockReturnValue(0);
		await advisory.remind(next, "timing", "status");
		current.mockClear();
		vi.advanceTimersByTime(14_999);
		expect(current).toHaveBeenCalledTimes(0);
		vi.advanceTimersByTime(1);
		expect(current).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(299_999);
		vi.advanceTimersByTime(284_999);
		expect(send).toHaveBeenCalledTimes(4);
		clock.mockReturnValue(300_000);
		vi.advanceTimersByTime(1);
		expect(send).toHaveBeenCalledTimes(5);
		const lateBinding = {
			ref: next,
			branchId: next.parentBranchId,
			senderInstanceId: "child-instance",
			recipientInstanceId: "parent-instance",
			requestId: "timing",
		};
		const lateReply = {
			...message,
			body: JSON.stringify({
				state: "progressing",
				progress: "worked",
				tried: [],
				blocker: "",
				nextAction: "continue",
				requestId: "timing",
			}),
			advisoryBinding: lateBinding,
		};
		expect(admitTaskAdvisory(parent, lateReply, lateBinding)).toBe("accept");
		rollbackTaskAdvisory(parent, lateReply);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(300_000);
		expect(send).toHaveBeenCalledTimes(5);
		const expiry = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		clock.mockReturnValue(0);
		await advisory.remind(expiry, "expiry", "status");
		expect(vi.getTimerCount()).toBe(1);
		lineage.navigate("parent");
		vi.advanceTimersByTime(15_000);
		expect(vi.getTimerCount()).toBe(0);
		const parked = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		await advisory.remind(parked, "park", "status");
		expect(vi.getTimerCount()).toBe(1);
		lineage.parkSession("parent");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		dispose();
		clock.mockRestore();
		send.mockRestore();
		current.mockRestore();
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
	}
});

it("expires a reminder when child messaging support changes", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	const messaging = { status: "supported" as const };
	const ref = lineage.mint("child", "parent", undefined, messaging);
	lineage.attach("child", "child-instance");
	let dispose = () => {};
	const parent = {
		sessionManager: { getSessionId: () => "parent" },
		subscribe: () => () => {},
		addDisposer: (fn: () => void) => {
			dispose = fn;
		},
	} as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => "child" } } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "TimerParent", displayName: "Parent", kind: "sub", session: parent });
	AgentRegistry.global().register({ id: "TimerChild", displayName: "Child", kind: "sub", session: child });
	const send = spyOn(IrcBus.global(), "sendBound").mockResolvedValue({ outcome: "injected" });
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	try {
		const advisory = createTaskAdvisory(parent, lineage);
		await advisory.remind(ref, "support-change", "status");
		Object.assign(messaging, { status: "unsupported", reasons: ["messaging-disabled"] });
		now = 300_000;
		vi.advanceTimersByTime(300_000);
		expect(send).toHaveBeenCalledTimes(1);
		const binding = {
			ref,
			branchId: ref.parentBranchId,
			senderInstanceId: "child-instance",
			recipientInstanceId: "parent-instance",
			requestId: "support-change",
		};
		const reply = {
			from: "TimerChild",
			to: "TimerParent",
			body: JSON.stringify({
				state: "progressing",
				progress: "worked",
				tried: [],
				blocker: "",
				nextAction: "continue",
				requestId: "support-change",
			}),
			advisoryBinding: binding,
		};
		expect(admitTaskAdvisory(parent, reply, binding)).toBe("reject");
	} finally {
		dispose();
		clock.mockRestore();
		send.mockRestore();
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
	}
});
