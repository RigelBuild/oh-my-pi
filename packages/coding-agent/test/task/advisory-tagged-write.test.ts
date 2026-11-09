import { expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { assignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

it("routes a tagged agent write through its live assignment binding", async () => {
	AgentRegistry.resetGlobalForTests();
	const registry = AgentRegistry.global();
	const parentId = crypto.randomUUID();
	const childId = crypto.randomUUID();
	const parent = { sessionManager: { getSessionId: () => parentId } } as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => childId } } as unknown as AgentSession;
	registry.register({ id: "Parent", displayName: "Parent", kind: "sub", session: parent });
	registry.register({ id: "Parent.Child", displayName: "Child", kind: "sub", session: child });
	assignmentLineage.attach(parentId, "parent-instance");
	const ref = assignmentLineage.mint(childId, parentId);
	assignmentLineage.attach(childId, "child-instance");
	const send = spyOn(IrcBus.global(), "sendBound").mockResolvedValue({ outcome: "injected" });
	const toolSession = {
		cwd: process.cwd(), hasUI: false, settings: Settings.isolated(), agentRegistry: registry,
		getAgentId: () => "Parent.Child", getSessionFile: () => null, taskDepth: 1,
	} as unknown as ToolSession;
	try {
		const result = await new WriteTool(toolSession).execute("write", { path: "agent://Parent", content: "progress", assignmentId: ref.assignmentId, checkId: "check-1" });
		expect(result.isError).not.toBe(true);
		expect(send).toHaveBeenCalledWith(
			{ from: "Parent.Child", to: "Parent", body: "progress", assignmentId: ref.assignmentId, checkId: "check-1" },
			{ ref, branchId: ref.parentBranchId, senderInstanceId: "child-instance", recipientInstanceId: "parent-instance", requestId: "check-1" },
		);
		const oversized = await new WriteTool(toolSession).execute("write-large", { path: "agent://Parent", content: "é".repeat(2049), assignmentId: ref.assignmentId });
		expect(oversized.isError).toBe(true);
	} finally {
		send.mockRestore();
		assignmentLineage.disposeSession(childId, "child-instance");
		assignmentLineage.disposeSession(parentId, "parent-instance");
		AgentRegistry.resetGlobalForTests();
	}
});
