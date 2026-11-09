import { describe, expect, test } from "bun:test";
import { AssignmentLineage } from "../../src/task/assignment-lineage";

describe("assignment lineage", () => {
	test("projects only immediate children and invalidates navigation", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("main", "main-instance");
		lineage.mint("manager", "main");
		lineage.attach("manager", "manager-instance");
		const ref = lineage.mint("child", "manager");
		lineage.attach("child", "child-instance");
		const binding = lineage.getAssignment("child");
		expect(binding?.ref).toEqual(ref);
		expect(lineage.children("manager").map(child => child.ref)).toEqual([ref]);
		expect(lineage.children("main").map(child => child.ref.childSessionId)).toEqual(["manager"]);
		if (!binding) throw new Error("missing binding");
		expect(lineage.isCurrent(ref, binding.instanceId, binding.branchId)).toBe(true);
		lineage.navigate("manager");
		lineage.navigate("manager");
		expect(lineage.isCurrent(ref, binding.instanceId, binding.branchId)).toBe(false);
	});

	test("requires attachment and replaces reassigned and terminal bindings", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const first = lineage.mint("child", "parent");
		expect(lineage.getAssignment("child")).toBeUndefined();
		lineage.attach("child", "instance");
		const active = lineage.getAssignment("child");
		if (!active) throw new Error("missing binding");
		lineage.wake("child");
		expect(lineage.isCurrent(first, "instance", active.branchId)).toBe(true);
		lineage.terminal("child", first.assignmentId);
		expect(lineage.isCurrent(first, "instance", active.branchId)).toBe(false);
		lineage.wake("child");
		const wake = lineage.getAssignment("child");
		expect(wake?.ref.assignmentId).not.toBe(first.assignmentId);
		const next = lineage.mint("child", "parent");
		expect(next.assignmentId).not.toBe(wake?.ref.assignmentId);
		expect(lineage.getAssignment("child")).toBeUndefined();
		lineage.attach("child", "instance");
		expect(lineage.getAssignment("child")?.parentInstanceId).toBe("parent-instance");
		lineage.attach("parent", "replacement-instance");
		expect(lineage.getAssignment("child")).toBeUndefined();
	});

	test("stale completion cannot terminalize a later assignment", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const first = lineage.mint("child", "parent");
		const second = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		lineage.terminal("child", first.assignmentId);
		expect(lineage.getAssignment("child")?.ref).toEqual(second);
		expect(lineage.getAssignment("child")?.phase).toBe("running");
	});

	test("rejects a child attached after its parent navigated during spawn", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const branch = lineage.branch("parent");
		lineage.navigate("parent");
		lineage.mint("child", "parent", branch);
		lineage.attach("child", "child-instance");
		expect(lineage.getAssignment("child")).toBeUndefined();
	});

	test("preserves unsupported messaging across wake", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const ref = lineage.mint("child", "parent", undefined, { status: "unsupported", reasons: ["extension-disabled"] });
		lineage.attach("child", "child-instance");
		lineage.terminal("child", ref.assignmentId);
		lineage.wake("child");
		expect(lineage.getAssignment("child")?.messaging).toEqual({ status: "unsupported", reasons: ["extension-disabled"] });
	});

	test("disposal removes only owned assignments and preserves sibling bindings", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("root", "root-instance");
		lineage.mint("manager", "root");
		lineage.attach("manager", "manager-instance");
		lineage.mint("sibling", "root");
		lineage.attach("sibling", "sibling-instance");
		lineage.mint("child", "manager");
		lineage.attach("child", "child-instance");
		const grandchild = lineage.mint("grandchild", "child");
		lineage.attach("grandchild", "grandchild-instance");
		const binding = lineage.getAssignment("grandchild");
		lineage.mint("other-child", "sibling");
		lineage.attach("other-child", "other-instance");
		if (!binding) throw new Error("missing grandchild");
		lineage.disposeSession("manager", "manager-instance");
		expect(lineage.getAssignment("manager")).toBeUndefined();
		expect(lineage.getAssignment("child")).toBeUndefined();
		expect(lineage.children("sibling")).toHaveLength(1);
		expect(lineage.isCurrent(grandchild, binding.instanceId, binding.branchId)).toBe(false);
		lineage.disposeSession("child", "child-instance");
		expect(lineage.isCurrent(grandchild, binding.instanceId, binding.branchId)).toBe(false);
	});

	test("distinguishes stale assignment, branch, and instance", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const ref = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		const binding = { ref, senderInstanceId: "parent-instance", recipientInstanceId: "child-instance", branchId: ref.parentBranchId };
		expect(lineage.validateBinding(binding, "parent", "child")).toBeUndefined();
		expect(lineage.validateBinding(binding, "other", "child")).toBe("stale-instance");
		expect(lineage.validateBinding(binding, "child", "parent")).toBe("stale-instance");
		expect(lineage.validateBinding({ ...binding, recipientInstanceId: "other" }, "parent", "child")).toBe("stale-instance");
		expect(lineage.validateBinding({ ...binding, ref: { ...ref, assignmentId: "other" } }, "parent", "child")).toBe("stale-assignment");
		lineage.navigate("parent");
		expect(lineage.validateBinding(binding, "parent", "child")).toBe("stale-parent-branch");
	});
});
