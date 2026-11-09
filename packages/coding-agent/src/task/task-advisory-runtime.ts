import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { AdvisorySnapshot, TaskAdvisory, TaskAdvisoryEvent } from "../extensibility/extensions/task-advisory";
import { IrcBus } from "../irc/bus";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { AdvisorySessionAdapter } from "./advisory-session-adapter";
import { type AssignmentBinding, type AssignmentLineage } from "./assignment-lineage";

const runtimes = new WeakMap<AgentSession, AdvisoryRuntime>();

class AdvisoryRuntime {
	readonly adapter = new AdvisorySessionAdapter();
	readonly listeners = new Set<(event: TaskAdvisoryEvent) => void>();
	readonly api: TaskAdvisory;
	lastSnapshot?: AdvisorySnapshot;

	constructor(readonly session: AgentSession, readonly lineage: AssignmentLineage) {
		this.api = {
			current: () => this.snapshot(this.lineage.getAssignment(this.id)),
			children: () => this.lineage.children(this.id).flatMap(binding => {
				const child = this.find(binding.ref.childSessionId);
				const snapshot = child && runtimes.get(child)?.snapshot(binding);
				return snapshot ? [snapshot] : [];
			}),
			subscribe: listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
			signal: (signal, count) => {
				const binding = this.lineage.getAssignment(this.id);
				if (!binding || !Number.isSafeInteger(count) || count < 0) return;
				this.publish({ type: "signal", ref: binding.ref, signal, count });
			},
			remind: async (ref, requestId, content) => {
				const binding = this.lineage.getAssignment(ref.childSessionId);
				if (!binding || ref.parentSessionId !== this.id || !this.lineage.isCurrent(ref, binding.instanceId, binding.branchId)) return { outcome: "unavailable", reason: "stale-assignment" };
				if (binding.messaging.status !== "supported") return { outcome: "unavailable", reason: "messaging-disabled" };
				const registry = AgentRegistry.global();
				const from = registry.list().find(item => item.session === this.session)?.id;
				const to = registry.list().find(item => item.session?.sessionManager.getSessionId() === ref.childSessionId)?.id;
				if (!from || !to) return { outcome: "unavailable", reason: "stale-instance" };
				return IrcBus.global().sendBound({ from, to, body: content, assignmentId: ref.assignmentId, checkId: requestId }, {
					ref, branchId: binding.branchId, senderInstanceId: binding.parentInstanceId, recipientInstanceId: binding.instanceId, requestId,
				});
			},
		};
		const unsubscribe = session.subscribe(event => {
			this.adapter.accept(event, performance.now());
			const snapshot = this.api.current();
			const previous = this.lastSnapshot;
			if (snapshot && (!previous || snapshot.ref.assignmentId !== previous.ref.assignmentId || snapshot.instanceId !== previous.instanceId || snapshot.phase !== previous.phase || snapshot.wallMs !== previous.wallMs || snapshot.unblockedMs !== previous.unblockedMs || snapshot.workTokens !== previous.workTokens || snapshot.usagePartial !== previous.usagePartial || snapshot.waitReasons.join(",") !== previous.waitReasons.join(",") || snapshot.messaging.status !== previous.messaging.status)) {
				this.lastSnapshot = snapshot;
				this.publish({ type: "snapshot", snapshot });
			}
		});
		session.addDisposer(() => { unsubscribe(); this.listeners.clear(); runtimes.delete(session); });
	}

	get id(): string { return this.session.sessionManager.getSessionId(); }

	find(id: string): AgentSession | undefined {
		return AgentRegistry.global().list().find(item => item.session?.sessionManager.getSessionId() === id)?.session ?? undefined;
	}

	snapshot(binding: AssignmentBinding | undefined): AdvisorySnapshot | undefined {
		if (!binding || binding.ref.childSessionId !== this.id) return undefined;
		const values = this.adapter.source.snapshot(performance.now());
		if (!values) return undefined;
		return { ref: binding.ref, instanceId: binding.instanceId, phase: binding.phase, ...values, messaging: binding.messaging,
			localCoverage: { edits: { status: "unavailable", reason: "detector-unregistered" }, loops: { status: "unavailable", reason: "detector-unregistered" } } };
	}

	publish(event: TaskAdvisoryEvent): void {
		for (const listener of this.listeners) listener(event);
		const parentId = event.type === "snapshot" ? event.snapshot.ref.parentSessionId : event.ref.parentSessionId;
		const parent = this.find(parentId);
		if (parent) for (const listener of runtimes.get(parent)?.listeners ?? []) listener(event);
	}
}

export function createTaskAdvisory(session: AgentSession, lineage: AssignmentLineage): TaskAdvisory {
	let runtime = runtimes.get(session);
	if (!runtime) { runtime = new AdvisoryRuntime(session, lineage); runtimes.set(session, runtime); }
	return runtime.api;
}

export function receiveTaskAdvisory(session: AgentSession, message: IrcMessage): void {
	const binding = message.advisoryBinding;
	if (!binding?.requestId || binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return;
	const runtime = runtimes.get(session);
	if (!runtime) return;
	for (const listener of runtime.listeners) listener({ type: "reply", ref: binding.ref, requestId: binding.requestId, senderInstanceId: binding.senderInstanceId, recipientInstanceId: binding.recipientInstanceId });
}

export function createTaskAdvisoryForSessionId(id: string): TaskAdvisory | undefined {
	const session = AgentRegistry.global().list().find(item => item.session?.sessionManager.getSessionId() === id)?.session;
	return session ? runtimes.get(session)?.api : undefined;
}
