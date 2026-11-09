import { expect, it, spyOn } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AssignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import { createTaskAdvisory } from "@oh-my-pi/pi-coding-agent/task/task-advisory-runtime";

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
