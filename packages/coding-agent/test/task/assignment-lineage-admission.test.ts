import { expect, it } from "bun:test";
import { AssignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";

it("retains admitted messages after terminal but rejects new sends and stale branches", () => {
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	const ref = lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	const binding = { ref, branchId: ref.parentBranchId, senderInstanceId: "child-instance", recipientInstanceId: "parent-instance" };
	expect(lineage.validateBinding(binding, "child", "parent")).toBeUndefined();
	lineage.terminal("child", ref.assignmentId);
	expect(lineage.validateBinding(binding, "child", "parent")).toBe("stale-assignment");
	expect(lineage.validateBinding(binding, "child", "parent", true)).toBeUndefined();
	lineage.wake("child");
	expect(lineage.validateBinding(binding, "child", "parent")).toBe("stale-assignment");
	expect(lineage.validateBinding(binding, "child", "parent", true)).toBeUndefined();
	lineage.navigate("parent");
	expect(lineage.validateBinding(binding, "child", "parent", true)).toBe("stale-parent-branch");
});
