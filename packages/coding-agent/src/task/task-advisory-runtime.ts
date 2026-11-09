import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { createHash } from "node:crypto";
import type { AdvisorySnapshot, TaskAdvisory, TaskAdvisoryEvent } from "../extensibility/extensions/task-advisory";
import { IrcBus } from "../irc/bus";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { AdvisorySessionAdapter } from "./advisory-session-adapter";
import { type AssignmentBinding, type AssignmentLineage } from "./assignment-lineage";

const runtimes = new WeakMap<AgentSession, AdvisoryRuntime>();

class AdvisoryRuntime {
	adapter = new AdvisorySessionAdapter();
	assignmentId?: string;
	readonly listeners = new Set<(event: TaskAdvisoryEvent) => void>();
	readonly api: TaskAdvisory;
	lastSnapshot?: AdvisorySnapshot;
	disposed = false;
	readonly expiredIds = new Set<string>();
	readonly watches = new Map<string, { timer: NodeJS.Timeout; content: string; reply?: string; replyDelivered?: boolean; expired: boolean }>();

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
				if (!binding || binding.phase !== "running" || !Number.isSafeInteger(count) || count < 0) return;
				this.publish({ type: "signal", ref: binding.ref, signal, count });
			},
			remind: async (ref, requestId, content) => {
				if (this.disposed) return { outcome: "unavailable", reason: "parent-gone" };
				if (!requestId || Buffer.byteLength(requestId) > 128 || Buffer.byteLength(ref.assignmentId) > 128 || Buffer.byteLength(ref.childSessionId) > 128 || Buffer.byteLength(ref.parentSessionId) > 128 || Buffer.byteLength(ref.parentBranchId) > 128 || Buffer.byteLength(content) > 4096) return { outcome: "unavailable", reason: "handoff-failed" };
				const binding = this.lineage.getAssignment(ref.childSessionId);
				if (!binding || ref.parentSessionId !== this.id || !this.lineage.isCurrent(ref, binding.instanceId, binding.branchId)) return { outcome: "unavailable", reason: "stale-assignment" };
				if (binding.messaging.status !== "supported") return { outcome: "unavailable", reason: "messaging-disabled" };
				const registry = AgentRegistry.global();
				const from = registry.list().find(item => item.session === this.session)?.id;
				const to = registry.list().find(item => item.session?.sessionManager.getSessionId() === ref.childSessionId)?.id;
				if (!from || !to) return { outcome: "unavailable", reason: "stale-instance" };
				const transport = { ref, branchId: binding.branchId, senderInstanceId: binding.parentInstanceId, recipientInstanceId: binding.instanceId, requestId };
				// Once its bounded tombstone is evicted, an extension may issue the ID anew.
				const key = `${ref.assignmentId}:${requestId}`;
				if (this.expiredIds.has(key)) return { outcome: "unavailable", reason: "stale-assignment" };
				const contentDigest = createHash("sha256").update(content).digest("hex");
				const previous = this.watches.get(key);
				if (previous) return previous.content === contentDigest && !previous.expired ? { outcome: "duplicate" } : { outcome: "unavailable", reason: "handoff-failed" };
				const started = performance.now();
				const timer = setInterval(() => {
					if (!this.lineage.isCurrent(ref, binding.instanceId, binding.branchId)) {
						clearInterval(timer);
						watch.expired = true;
						return;
					}
					if (performance.now() - started < 300_000) return;
					clearInterval(timer);
					void IrcBus.global().sendBound({ from, to, body: "Please share your progress and next action.", assignmentId: ref.assignmentId, checkId: requestId }, transport).catch(() => {});
				}, 15_000);
				const watch = { timer, content: contentDigest, expired: false };
				const assignmentKeys = [...this.watches.keys()].filter(item => item.startsWith(`${ref.assignmentId}:`));
				if (assignmentKeys.length >= 64) {
					const oldest = assignmentKeys[0];
					if (oldest !== undefined) {
						clearInterval(this.watches.get(oldest)?.timer);
						this.watches.delete(oldest);
						this.expiredIds.add(oldest);
						if (this.expiredIds.size > 64) {
							const first = this.expiredIds.values().next().value;
							if (first !== undefined) this.expiredIds.delete(first);
						}
					}
				}
				this.watches.set(key, watch);
				let receipt;
				try {
					receipt = await IrcBus.global().sendBound({ from, to, body: content, assignmentId: ref.assignmentId, checkId: requestId }, transport);
				} catch {
					receipt = { outcome: "unavailable", reason: "handoff-failed" } as const;
				}
				if (receipt.outcome === "unavailable" || !this.lineage.isCurrent(ref, binding.instanceId, binding.branchId)) {
					clearInterval(timer);
					watch.expired = true;
				}
				return receipt;
			},
		};
		const stopTerminal = lineage.onTerminal(assignmentId => {
			for (const [key, watch] of this.watches) {
				if (!key.startsWith(`${assignmentId}:`)) continue;
				clearInterval(watch.timer);
				this.watches.delete(key);
			}
		});
		const unsubscribe = session.subscribe(event => {
			const binding = this.lineage.getAssignment(this.id);
			if (binding && binding.ref.assignmentId !== this.assignmentId) {
				this.assignmentId = binding.ref.assignmentId;
				this.adapter = new AdvisorySessionAdapter();
				this.lastSnapshot = undefined;
			}
			this.adapter.accept(event, performance.now());
			const snapshot = this.api.current();
			const previous = this.lastSnapshot;
			if (snapshot && (!previous || snapshot.ref.assignmentId !== previous.ref.assignmentId || snapshot.instanceId !== previous.instanceId || snapshot.phase !== previous.phase || snapshot.workTokens !== previous.workTokens || snapshot.usagePartial !== previous.usagePartial || snapshot.waitReasons.join(",") !== previous.waitReasons.join(",") || snapshot.messaging.status !== previous.messaging.status)) {
				this.lastSnapshot = snapshot;
				this.publish({ type: "snapshot", snapshot });
			}
		});
		session.addDisposer(() => { this.disposed = true; unsubscribe(); stopTerminal(); for (const watch of this.watches.values()) clearInterval(watch.timer); this.watches.clear(); this.listeners.clear(); runtimes.delete(session); });
	}

	get id(): string { return this.session.sessionManager.getSessionId(); }

	find(id: string): AgentSession | undefined {
		return AgentRegistry.global().list().find(item => item.session?.sessionManager.getSessionId() === id)?.session ?? undefined;
	}

	snapshot(binding: AssignmentBinding | undefined): AdvisorySnapshot | undefined {
		if (!binding || binding.ref.childSessionId !== this.id) return undefined;
		if (binding.ref.assignmentId !== this.assignmentId) return undefined;
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
	if (!binding || binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return;
	const runtime = runtimes.get(session);
	if (!runtime) return;
	if (binding.requestId && !runtime.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`)?.reply) return;
	if (binding.requestId) {
		const watch = runtime.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
		if (watch) { clearInterval(watch.timer); watch.replyDelivered = true; }
	}
	for (const listener of runtime.listeners) listener({ type: "reply", ref: binding.ref, requestId: binding.requestId ?? "", senderInstanceId: binding.senderInstanceId, recipientInstanceId: binding.recipientInstanceId });
}

export function admitTaskAdvisory(session: AgentSession, message: Omit<IrcMessage, "id" | "ts">, binding: NonNullable<IrcMessage["advisoryBinding"]>): "accept" | "duplicate" | "reject" {
	if (binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return "accept";
	if (!binding.requestId) return "accept";
	const watch = runtimes.get(session)?.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
	if (!watch || watch.expired) return "reject";
	const digest = createHash("sha256").update(message.body).digest("hex");
	if (watch.reply !== undefined) return watch.replyDelivered && watch.reply === digest ? "duplicate" : "reject";
	watch.reply = digest;
	return "accept";
}

export function rollbackTaskAdvisory(session: AgentSession, message: IrcMessage): void {
	const binding = message.advisoryBinding;
	if (!binding?.requestId || binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return;
	const watch = runtimes.get(session)?.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
	if (watch) { watch.reply = undefined; watch.replyDelivered = false; }
}

export function createTaskAdvisoryForSessionId(id: string): TaskAdvisory | undefined {
	const session = AgentRegistry.global().list().find(item => item.session?.sessionManager.getSessionId() === id)?.session;
	return session ? runtimes.get(session)?.api : undefined;
}
