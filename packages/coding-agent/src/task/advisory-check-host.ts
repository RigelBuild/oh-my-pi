import type { AdvisoryReceipt, AssignmentRef, LocalSignal } from "../extensibility/extensions/task-advisory";
import type { AdvisorySnapshotSource, AdvisorySourceSnapshot } from "./advisory-snapshot-source";

export type AdvisoryCheckPolicy = {
	wallMs: number;
	tokenStep: number;
	localThresholds: Readonly<Record<LocalSignal, number>>;
	reminderCooldownMs: number;
	noReplyMs: number;
	pollMs: number;
};

type Check = { id: string; sentAt: number; followUpSent: boolean };
type Child = {
	ref: AssignmentRef;
	check?: Check;
	wallBaseline: number;
	tokenBaseline: number;
	tokenLatched: boolean;
	localLatched: Set<LocalSignal>;
	cooldownRemaining: number;
	lastUnblocked: number | null;
	cancelTimer?: () => void;
};

type Dependencies = {
	now: () => number;
	schedule: (fn: () => void, ms: number) => () => void;
	send: (child: AssignmentRef, text: string, binding: { assignmentId: string; checkId: string }) => Promise<AdvisoryReceipt>;
	isCurrent: (assignmentId: string) => boolean;
	newCheckId: () => string;
	policy: AdvisoryCheckPolicy;
};

const reminder = "Please share your current state, concrete progress, actions, blocker, and next action.";
const followUp = "Please share your progress and next action.";

/** One host tracks immediate children; inputs are already normalized by the snapshot source. */
export class AdvisoryCheckHost {
	readonly #children = new Map<string, Child>();
	readonly #ticks = new Map<string, () => void>();
	constructor(readonly deps: Dependencies) {}

	/** Call once when the child source becomes ready. */
	watch(ref: AssignmentRef, source: AdvisorySnapshotSource, state: () => { local: Readonly<Partial<Record<LocalSignal, number>>>; messagingSupported: boolean }): void {
		this.#ticks.get(ref.childSessionId)?.();
		const tick = () => {
			if (!this.deps.isCurrent(ref.assignmentId)) {
				this.#ticks.delete(ref.childSessionId);
				return;
			}
			const snapshot = source.snapshot(this.deps.now());
			if (snapshot) {
				const current = state();
				this.observe(ref, snapshot, current.local, current.messagingSupported);
			}
			this.#ticks.set(ref.childSessionId, this.deps.schedule(tick, this.deps.policy.pollMs));
		};
		this.#ticks.set(ref.childSessionId, this.deps.schedule(tick, this.deps.policy.pollMs));
	}

	observe(ref: AssignmentRef, snapshot: AdvisorySourceSnapshot, local: Readonly<Partial<Record<LocalSignal, number>>>, messagingSupported: boolean): string | undefined {
		if (!this.deps.isCurrent(ref.assignmentId)) return undefined;
		let child = this.#children.get(ref.childSessionId);
		if (!child || child.ref.assignmentId !== ref.assignmentId) {
			child?.cancelTimer?.();
			child = { ref, wallBaseline: 0, tokenBaseline: 0, tokenLatched: false, localLatched: new Set(), cooldownRemaining: 0, lastUnblocked: null };
			this.#children.set(ref.childSessionId, child);
		}
		if (snapshot.unblockedMs !== null && child.lastUnblocked !== null) {
			child.cooldownRemaining = Math.max(0, child.cooldownRemaining - Math.max(0, snapshot.unblockedMs - child.lastUnblocked));
		}
		child.lastUnblocked = snapshot.unblockedMs;
		if (child.check) return child.check.id;

		const wallDue = snapshot.wallMs - child.wallBaseline >= this.deps.policy.wallMs;
		const tokenDue = !child.tokenLatched && snapshot.workTokens !== null && snapshot.workTokens - child.tokenBaseline >= this.deps.policy.tokenStep;
		const signals: LocalSignal[] = ["edit-repeat", "tool-repeat"];
		const localDue = signals.filter(signal => !child.localLatched.has(signal) && (local[signal] ?? 0) >= this.deps.policy.localThresholds[signal]);
		if (!wallDue && !tokenDue && localDue.length === 0) return undefined;
		if (messagingSupported && child.cooldownRemaining > 0) return undefined;
		if (wallDue) child.wallBaseline = snapshot.wallMs;
		if (tokenDue) child.tokenLatched = true;
		for (const signal of localDue) child.localLatched.add(signal);
		if (!messagingSupported) return undefined;

		const check: Check = { id: this.deps.newCheckId(), sentAt: this.deps.now(), followUpSent: false };
		child.check = check;
		this.#poll(child, check);
		void this.#sendReminder(child, check, snapshot.unblockedMs);
		return check.id;
	}

	async #sendReminder(child: Child, check: Check, unblockedMs: number | null): Promise<void> {
		let receipt: AdvisoryReceipt;
		try {
			receipt = await this.deps.send(child.ref, reminder, { assignmentId: child.ref.assignmentId, checkId: check.id });
		} catch {
			receipt = { outcome: "unavailable", reason: "handoff-failed" };
		}
		if (!this.deps.isCurrent(child.ref.assignmentId) || this.#children.get(child.ref.childSessionId) !== child) return;
		if (receipt.outcome === "unavailable") {
			if (child.check !== check) return;
			child.cancelTimer?.();
			child.cancelTimer = undefined;
			child.check = undefined;
			return;
		}
		child.cooldownRemaining = this.deps.policy.reminderCooldownMs;
		if (child.lastUnblocked === null) child.lastUnblocked = unblockedMs;
	}

	#poll(child: Child, check: Check): void {
		child.cancelTimer = this.deps.schedule(() => {
			child.cancelTimer = undefined;
			if (child.check !== check || !this.deps.isCurrent(child.ref.assignmentId)) return;
			if (this.deps.now() - check.sentAt >= this.deps.policy.noReplyMs) {
				if (!check.followUpSent) {
					check.followUpSent = true;
					void this.deps.send(child.ref, followUp, { assignmentId: child.ref.assignmentId, checkId: check.id }).catch(() => {});
				}
				return;
			}
			this.#poll(child, check);
		}, this.deps.policy.pollMs);
	}

	reply(binding: { assignmentId: string; checkId: string }): boolean {
		for (const child of this.#children.values()) {
			if (child.ref.assignmentId !== binding.assignmentId || child.check?.id !== binding.checkId || !this.deps.isCurrent(binding.assignmentId)) continue;
			child.cancelTimer?.();
			child.cancelTimer = undefined;
			child.check = undefined;
			return true;
		}
		return false;
	}

	report(ref: AssignmentRef, snapshot: AdvisorySourceSnapshot): void {
		const child = this.#children.get(ref.childSessionId);
		if (!child || child.ref.assignmentId !== ref.assignmentId || !this.deps.isCurrent(ref.assignmentId)) return;
		child.cancelTimer?.();
		child.cancelTimer = undefined;
		child.check = undefined;
		child.wallBaseline = snapshot.wallMs;
		child.tokenBaseline = snapshot.workTokens ?? 0;
		child.tokenLatched = false;
		child.localLatched.clear();
	}

	dispose(): void {
		for (const cancel of this.#ticks.values()) cancel();
		this.#ticks.clear();
		for (const child of this.#children.values()) child.cancelTimer?.();
		this.#children.clear();
	}
}
