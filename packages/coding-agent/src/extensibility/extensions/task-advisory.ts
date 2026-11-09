export type AssignmentRef = {
	childSessionId: string;
	assignmentId: string;
	parentSessionId: string;
	parentBranchId: string;
};

export type WaitReason = "approval" | "ask" | "wait" | "tool" | "async" | "retry" | "compaction" | "unknown";
export type AdvisoryUnsupportedReason = "extension-disabled" | "messaging-disabled";
export type AdvisoryMessagingSupport =
	| { status: "supported" }
	| { status: "unsupported"; reasons: readonly [AdvisoryUnsupportedReason, ...AdvisoryUnsupportedReason[]] };
export type DetectorCoverage =
	| { status: "full" }
	| { status: "partial" | "unavailable"; reason: "detector-unregistered" | "edit-inspection-unavailable" | "fingerprint-limits" };
export type AdvisoryLocalCoverage = { edits: DetectorCoverage; loops: DetectorCoverage };
export type AdvisorySnapshot = {
	ref: AssignmentRef;
	instanceId: string;
	phase: "running" | "paused" | "terminal";
	wallMs: number;
	unblockedMs: number | null;
	waitReasons: readonly WaitReason[];
	workTokens: number | null;
	usagePartial: boolean;
	modelRole?: string;
	messaging: AdvisoryMessagingSupport;
	localCoverage: AdvisoryLocalCoverage;
};
export type LocalSignal = "edit-repeat" | "tool-repeat";
export type AdvisoryMessageBinding = {
	ref: AssignmentRef;
	requestId: string;
	senderInstanceId: string;
	recipientInstanceId: string;
};
export type AdvisoryReceipt =
	| { outcome: "injected" | "woken" | "revived" | "duplicate" }
	| { outcome: "unavailable"; reason: "messaging-disabled" | "parent-gone" | "stale-assignment" | "stale-parent-branch" | "stale-instance" | "handoff-failed" };
export type TaskAdvisoryEvent =
	| { type: "snapshot"; snapshot: AdvisorySnapshot }
	| { type: "signal"; ref: AssignmentRef; signal: LocalSignal; count: number }
	| { type: "reply"; ref: AssignmentRef; requestId: string; senderInstanceId: string; recipientInstanceId: string };

export interface TaskAdvisory {
	current(): AdvisorySnapshot | undefined;
	children(): readonly AdvisorySnapshot[];
	subscribe(listener: (event: TaskAdvisoryEvent) => void): () => void;
	signal(signal: LocalSignal, count: number): void;
	remind(ref: AssignmentRef, requestId: string, content: string): Promise<AdvisoryReceipt>;
}
