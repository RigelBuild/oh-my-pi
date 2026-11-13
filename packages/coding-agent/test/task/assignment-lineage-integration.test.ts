import { expect, it } from "bun:test";
import { AdvisoryHub, advisoryNow } from "../../src/task/advisory-hub";

it("binds nested assignments to their immediate parent and invalidates them on navigation", () => {
	const hub = new AdvisoryHub();
	hub.attach({ sessionId: "root", instanceId: "r", agentId: "Root" });
	const manager = hub.mint({ childSessionId: "manager", parentSessionId: "root", messaging: { status: "supported" } });
	hub.attach({ sessionId: "manager", instanceId: "m", agentId: "Manager" });
	const child = hub.mint({ childSessionId: "child", parentSessionId: "manager", messaging: { status: "supported" } });
	hub.attach({ sessionId: "child", instanceId: "c", agentId: "Child" });
	hub.publishEvent("manager", "m", { kind: "ready", at: advisoryNow() });
	hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
	expect(hub.children("root").map(item => item.ref)).toEqual([manager]);
	expect(hub.children("manager").map(item => item.ref)).toEqual([child]);
	hub.navigate("manager");
	expect(hub.children("manager")).toEqual([]);
	expect(hub.children("root")).toEqual([]);
});
