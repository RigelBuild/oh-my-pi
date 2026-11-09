import { expect, it } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AssignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import { createTaskAdvisory } from "@oh-my-pi/pi-coding-agent/task/task-advisory-runtime";

it("retains a paused snapshot when the child parks", () => {
	AgentRegistry.resetGlobalForTests();
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let emit: (event: AgentSessionEvent) => void = () => {};
	const disposers: Array<() => void> = [];
	const parent = { sessionManager: { getSessionId: () => "parent" }, subscribe: () => () => {}, addDisposer: (fn: () => void) => disposers.push(fn) } as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => "child" }, subscribe: (fn: typeof emit) => { emit = fn; return () => {}; }, addDisposer: (fn: () => void) => disposers.push(fn) } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "SnapshotParent", displayName: "Parent", kind: "sub", session: parent });
	AgentRegistry.global().register({ id: "SnapshotChild", displayName: "Child", kind: "sub", parentId: "SnapshotParent", session: child });
	try {
		const advisory = createTaskAdvisory(parent, lineage);
		createTaskAdvisory(child, lineage);
		emit({ type: "agent_start" });
		expect(advisory.children()[0]?.phase).toBe("running");
		lineage.parkSession("child");
		AgentRegistry.global().detachSession("SnapshotChild");
		expect(advisory.children()[0]?.phase).toBe("paused");
	} finally {
		for (const dispose of disposers) dispose();
		AgentRegistry.resetGlobalForTests();
	}
});
