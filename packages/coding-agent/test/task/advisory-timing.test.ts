import { expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AssignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import { createTaskAdvisory } from "@oh-my-pi/pi-coding-agent/task/task-advisory-runtime";

it("checks every 15 seconds and sends one follow-up at 300 seconds", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	const ref = lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let dispose = () => {};
	const parent = { sessionManager: { getSessionId: () => "parent" }, subscribe: () => () => {}, addDisposer: (fn: () => void) => { dispose = fn; } } as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => "child" } } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "TimerParent", displayName: "Parent", kind: "sub", session: parent });
	AgentRegistry.global().register({ id: "TimerChild", displayName: "Child", kind: "sub", session: child });
	const send = spyOn(IrcBus.global(), "sendBound").mockResolvedValue({ outcome: "injected" });
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const current = spyOn(lineage, "isCurrent");
	try {
		await createTaskAdvisory(parent, lineage).remind(ref, "timing", "status");
		current.mockClear();
		vi.advanceTimersByTime(14_999);
		expect(current).toHaveBeenCalledTimes(0);
		vi.advanceTimersByTime(1);
		expect(current).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(299_999);
		vi.advanceTimersByTime(284_999);
		expect(send).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(300_000);
		vi.advanceTimersByTime(1);
		expect(send).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(300_000);
		expect(send).toHaveBeenCalledTimes(2);
	} finally {
		dispose();
		clock.mockRestore();
		send.mockRestore();
		current.mockRestore();
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
	}
});
