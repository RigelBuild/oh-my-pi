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
		lineage.terminal("child");
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
});
