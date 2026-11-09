import type { AdvisoryMessagingSupport, AssignmentRef } from "../extensibility/extensions/task-advisory";

export interface AssignmentBinding {
	ref: AssignmentRef;
	instanceId: string;
	parentInstanceId: string;
	branchId: string;
	messaging: AdvisoryMessagingSupport;
	phase: "running" | "terminal";
}

interface PendingAssignment {
	ref: AssignmentRef;
	instanceId?: string;
	parentInstanceId?: string;
	branchId: string;
	childBranchId: string;
	messaging: AdvisoryMessagingSupport;
	phase: "running" | "terminal";
}

/** Live assignment identities. The owner wires session attachment and lifecycle transitions. */
export class AssignmentLineage {
	readonly #assignments = new Map<string, PendingAssignment>();
	readonly #branches = new Map<string, string>();
	readonly #instances = new Map<string, string>();
	readonly #orphaned = new Set<string>();

	branch(sessionId: string): string {
		let branch = this.#branches.get(sessionId);
		if (!branch) {
			branch = crypto.randomUUID();
			this.#branches.set(sessionId, branch);
		}
		return branch;
	}

	navigate(sessionId: string): void {
		this.#branches.set(sessionId, crypto.randomUUID());
	}

	disposeSession(sessionId: string, instanceId: string): void {
		if (this.#instances.get(sessionId) !== instanceId) return;
		this.#instances.delete(sessionId);
		this.#branches.delete(sessionId);
		this.#assignments.delete(sessionId);
		this.#orphaned.delete(sessionId);
		for (const [childId, assignment] of this.#assignments) {
			if (assignment.ref.parentSessionId !== sessionId) continue;
			this.#assignments.delete(childId);
			this.#orphaned.add(childId);
		}
	}

	mint(childSessionId: string, parentSessionId: string, branchId = this.branch(parentSessionId), messaging: AdvisoryMessagingSupport = { status: "supported" }): AssignmentRef {
		const ref: AssignmentRef = { childSessionId, parentSessionId, parentBranchId: branchId, assignmentId: crypto.randomUUID() };
		this.#assignments.set(childSessionId, { ref, branchId, childBranchId: this.branch(childSessionId), phase: "running", messaging });
		this.#orphaned.delete(childSessionId);
		return ref;
	}

	attach(sessionId: string, instanceId: string): void {
		this.#instances.set(sessionId, instanceId);
		const assignment = this.#assignments.get(sessionId);
		if (assignment) {
			assignment.instanceId = instanceId;
			assignment.parentInstanceId = this.#instances.get(assignment.ref.parentSessionId);
		}
	}

	terminal(sessionId: string, assignmentId: string): void {
		const assignment = this.#assignments.get(sessionId);
		if (assignment?.ref.assignmentId === assignmentId) assignment.phase = "terminal";
	}

	wake(sessionId: string): void {
		const assignment = this.#assignments.get(sessionId);
		if (!assignment || assignment.phase !== "terminal") return;
		const instanceId = assignment.instanceId;
		this.mint(sessionId, assignment.ref.parentSessionId, this.branch(assignment.ref.parentSessionId), assignment.messaging);
		if (instanceId) this.attach(sessionId, instanceId);
	}

	getAssignment(sessionId: string): AssignmentBinding | undefined {
		const assignment = this.#assignments.get(sessionId);
		if (!assignment?.instanceId || !assignment.parentInstanceId || this.#orphaned.has(assignment.ref.parentSessionId) || this.#instances.get(assignment.ref.parentSessionId) !== assignment.parentInstanceId || this.branch(assignment.ref.parentSessionId) !== assignment.branchId || this.branch(sessionId) !== assignment.childBranchId) return undefined;
		return { ref: assignment.ref, instanceId: assignment.instanceId, parentInstanceId: assignment.parentInstanceId, branchId: assignment.branchId, phase: assignment.phase, messaging: assignment.messaging };
	}

	isCurrent(ref: AssignmentRef, instanceId: string, branchId: string): boolean {
		const current = this.getAssignment(ref.childSessionId);
		return current !== undefined && current.phase === "running" && current.instanceId === instanceId && current.branchId === branchId && current.ref.assignmentId === ref.assignmentId && current.ref.parentSessionId === ref.parentSessionId && current.ref.parentBranchId === ref.parentBranchId;
	}

	children(parentSessionId: string): AssignmentBinding[] {
		const children: AssignmentBinding[] = [];
		for (const assignment of this.#assignments.values()) {
			if (assignment.ref.parentSessionId !== parentSessionId) continue;
			const binding = this.getAssignment(assignment.ref.childSessionId);
			if (binding) children.push(binding);
		}
		return children;
	}
}

export const assignmentLineage = new AssignmentLineage();
