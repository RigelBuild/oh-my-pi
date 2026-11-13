import type { AdvisoryReceipt, AdvisorySnapshot, AssignmentRef, LocalSignal, TaskAdvisoryEvent } from "../../extensibility/extensions/task-advisory";
import type { AdvisoryAttach, AdvisoryCheck, AdvisoryMint, AdvisoryRemind, AdvisoryReply } from "../../task/advisory-hub";
import type { AdvisoryEvent } from "../../task/advisory-snapshot-source";
import type { AssignmentBinding } from "../../task/assignment-lineage";
import type { RpcMethod } from "../rpc";
import type { WireCallback, WireUnsubscribe } from "./support";

export const ADVISORY_HUB_KIND = "advisory-hub";
export type AdvisoryHubProtocol = {
	attach: RpcMethod<[input: AdvisoryAttach], void>;
	detach: RpcMethod<[sessionId: string, instanceId: string], void>;
	branch: RpcMethod<[sessionId: string], string>;
	navigate: RpcMethod<[sessionId: string], void>;
	mint: RpcMethod<[input: AdvisoryMint], AssignmentRef>;
	mintFollowUp: RpcMethod<[childSessionId: string, parentAgentId: string], AssignmentRef | undefined>;
	wake: RpcMethod<[sessionId: string], void>;
	terminal: RpcMethod<[sessionId: string, assignmentId: string], void>;
	getAssignment: RpcMethod<[sessionId: string], AssignmentBinding | undefined>;
	current: RpcMethod<[sessionId: string], AdvisorySnapshot | undefined>;
	children: RpcMethod<[parentSessionId: string], AdvisorySnapshot[]>;
	publishEvent: RpcMethod<[sessionId: string, instanceId: string, event: AdvisoryEvent], void>;
	signal: RpcMethod<[sessionId: string, signal: LocalSignal, count: number], void>;
	subscribe: RpcMethod<[sessionId: string, listener: WireCallback<[TaskAdvisoryEvent]>], WireUnsubscribe>;
	remind: RpcMethod<[input: AdvisoryRemind], AdvisoryReceipt>;
	sendBound: RpcMethod<[input: AdvisoryReply], AdvisoryReceipt>;
	validate: RpcMethod<[checks: readonly AdvisoryCheck[]], boolean[]>;
};
