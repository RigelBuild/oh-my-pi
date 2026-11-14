import { describe, expect, test } from "bun:test";
import { AssignmentLineage } from "../../src/task/assignment-lineage";

describe("assignment lineage", () => {
	test("projects immediate children and invalidates navigation", () => {
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
		expect(lineage.isCurrent(ref, binding.instanceId, binding.branchId)).toBe(false);
	});

	test("requires attachment and replaces terminal assignments on wake", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const first = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		const active = lineage.getAssignment("child");
		expect(active).toBeDefined();
		lineage.terminal("child", first.assignmentId);
		if (!active) throw new Error("missing binding");
		const binding = {
			ref: first,
			senderInstanceId: "parent-instance",
			recipientInstanceId: "child-instance",
			branchId: active.branchId,
		};
		expect(lineage.validateBinding(binding, "parent", "child", true)).toBeUndefined();
		lineage.wake("child");
		expect(lineage.validateBinding(binding, "parent", "child", true)).toBe("stale-assignment");
		expect(lineage.getAssignment("child")?.ref.assignmentId).not.toBe(first.assignmentId);
	});

	test("notifies once for direct mint, wake, and parked revival, but not live attach", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const minted: string[] = [];
		lineage.onMint(ref => minted.push(ref.assignmentId));
		const first = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		expect(minted).toEqual([first.assignmentId]);
		lineage.terminal("child", first.assignmentId);
		lineage.wake("child");
		const wake = lineage.assignmentIdOf("child");
		expect(minted).toHaveLength(2);
		if (wake === undefined) throw new Error("wake must mint an assignment");
		expect(minted[1]).toBe(wake);
		lineage.disposeSession("child", "child-instance", "park");
		lineage.attach("child", "revived-instance");
		expect(minted).toHaveLength(3);
		const revived = lineage.assignmentIdOf("child");
		if (revived === undefined) throw new Error("revival must mint an assignment");
		expect(minted[2]).toBe(revived);
	});

	test("reports stored assignment id through terminal phase and clears it on disposal", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const ref = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		lineage.terminal("child", ref.assignmentId);
		expect(lineage.assignmentIdOf("child")).toBe(ref.assignmentId);
		lineage.disposeSession("child", "child-instance");
		expect(lineage.assignmentIdOf("child")).toBeUndefined();
	});

	test("reattaches parked parent only on the same branch and expires parked children", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "old-instance");
		const ref = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		lineage.disposeSession("parent", "old-instance", "park");
		lineage.attach("parent", "new-instance");
		expect(lineage.children("parent")[0]?.ref).toEqual(ref);
		lineage.disposeSession("parent", "new-instance", "park");
		lineage.expireParked("parent");
		expect(lineage.children("parent")).toEqual([]);
		expect(lineage.assignmentIdOf("child")).toBeUndefined();
	});

	test("preserves unsupported messaging across wake", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "parent-instance");
		const ref = lineage.mint("child", "parent", undefined, {
			status: "unsupported",
			reasons: ["extension-disabled"],
		});
		lineage.attach("child", "child-instance");
		lineage.terminal("child", ref.assignmentId);
		lineage.wake("child");
		expect(lineage.getAssignment("child")?.messaging).toEqual({
			status: "unsupported",
			reasons: ["extension-disabled"],
		});
	});
	test("stale completion cannot terminalize a later assignment", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "p");
		const first = lineage.mint("child", "parent");
		const second = lineage.mint("child", "parent");
		lineage.attach("child", "c");
		lineage.terminal("child", first.assignmentId);
		expect(lineage.getAssignment("child")).toMatchObject({ ref: second, phase: "running" });
	});
	test("rejects a child attached after parent navigation", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "p");
		const branch = lineage.branch("parent");
		lineage.navigate("parent");
		lineage.mint("child", "parent", branch);
		lineage.attach("child", "c");
		expect(lineage.getAssignment("child")).toBeUndefined();
	});
	test("disposal preserves sibling assignments", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("root", "r");
		lineage.mint("manager", "root");
		lineage.attach("manager", "m");
		lineage.mint("sibling", "root");
		lineage.attach("sibling", "s");
		lineage.mint("child", "manager");
		lineage.attach("child", "c");
		lineage.mint("other", "sibling");
		lineage.attach("other", "o");
		lineage.disposeSession("manager", "m");
		expect(lineage.getAssignment("child")).toBeUndefined();
		expect(lineage.children("sibling")).toHaveLength(1);
	});
	test("distinguishes assignment, branch and instance failures", () => {
		const lineage = new AssignmentLineage();
		lineage.attach("parent", "p");
		const ref = lineage.mint("child", "parent");
		lineage.attach("child", "c");
		const binding = { ref, senderInstanceId: "p", recipientInstanceId: "c", branchId: ref.parentBranchId };
		expect(lineage.validateBinding(binding, "parent", "child")).toBeUndefined();
		expect(lineage.validateBinding(binding, "other", "child")).toBe("stale-instance");
		expect(lineage.validateBinding(binding, "child", "parent")).toBe("stale-instance");
		expect(lineage.validateBinding({ ...binding, ref: { ...ref, assignmentId: "other" } }, "parent", "child")).toBe(
			"stale-assignment",
		);
		lineage.terminal("child", ref.assignmentId);
		expect(lineage.validateBinding(binding, "parent", "child")).toBe("stale-assignment");
		expect(lineage.validateBinding(binding, "parent", "child", true)).toBeUndefined();
		lineage.navigate("parent");
		expect(lineage.validateBinding(binding, "parent", "child", true)).toBe("stale-parent-branch");
	});
});
