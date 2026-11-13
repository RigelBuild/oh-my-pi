import { expect, it, spyOn } from "bun:test";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { AdvisoryHub } from "../../src/task/advisory-hub";
import type { ToolSession } from "../../src/tools";
import { WriteTool } from "../../src/tools/write";

it("routes tagged writes and excludes invalid report bodies from errors", async () => {
	AgentRegistry.resetGlobalForTests();
	AdvisoryHub.resetGlobalForTests();
	const registry = AgentRegistry.global();
	const parentId = crypto.randomUUID();
	const childId = crypto.randomUUID();
	const parent = { sessionManager: { getSessionId: () => parentId } } as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => childId } } as unknown as AgentSession;
	registry.register({ id: "Parent", displayName: "Parent", kind: "sub", session: parent });
	registry.register({ id: "Parent.Child", displayName: "Child", kind: "sub", session: child });
	const hub = AdvisoryHub.main();
	hub.attach({ sessionId: parentId, instanceId: "parent-instance", agentId: "Parent" });
	const ref = hub.mint({ childSessionId: childId, parentSessionId: parentId, messaging: { status: "supported" } });
	hub.attach({ sessionId: childId, instanceId: "child-instance", agentId: "Parent.Child" });
	const send = spyOn(hub, "sendBound").mockResolvedValue({ outcome: "injected" });
	const toolSession = { cwd: process.cwd(), hasUI: false, settings: Settings.isolated(), agentRegistry: registry, getAgentId: () => "Parent.Child", getSessionFile: () => null, taskDepth: 1 } as unknown as ToolSession;
	try {
		const report = JSON.stringify({ state: "progressing", progress: "worked", tried: [], blocker: "", nextAction: "continue" });
		const tool = new WriteTool(toolSession);
		const result = await tool.execute("write", { path: "agent://Parent", content: report, assignmentId: ref.assignmentId, checkId: "check-1" });
		expect(result.isError).not.toBe(true);
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: childId, fromAgentId: "Parent.Child", toAgentId: "Parent", body: report, assignmentId: ref.assignmentId, checkId: "check-1" }));
		const privateInput = "PRIVATE_REPORT_BODY_MUST_NOT_APPEAR";
		const invalid = await tool.execute("invalid", { path: "agent://Parent", content: privateInput, assignmentId: ref.assignmentId, checkId: "check-1" });
		expect(invalid.isError).toBe(true);
		expect(JSON.stringify(invalid.content)).not.toContain(privateInput);
		const oversized = await tool.execute("large", { path: "agent://Parent", content: "é".repeat(2049), assignmentId: ref.assignmentId });
		expect(oversized.isError).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
	} finally {
		send.mockRestore();
		hub.detach(childId, "child-instance");
		hub.detach(parentId, "parent-instance");
		AdvisoryHub.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	}
});
