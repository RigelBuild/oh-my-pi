import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { createHash } from "node:crypto";
import type {
	AdvisorySnapshot,
	AdvisoryState,
	TaskAdvisory,
	TaskAdvisoryEvent,
} from "../extensibility/extensions/task-advisory";
import { IrcBus } from "../irc/bus";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { parseReportInput } from "./advisory-report";
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
	readonly issuedIds = new Map<string, string>();
	readonly parkedSnapshots = new Map<string, AdvisorySnapshot>();
	readonly replyStates = new WeakMap<object, AdvisoryState>();
	readonly watches = new Map<
		string,
		{
			timer: NodeJS.Timeout;
			content: string;
			reply?: string;
			replyDelivered?: boolean;
			expired: boolean;
			pending: boolean;
			followUpSent: boolean;
			rearm: () => void;
		}
	>();

	constructor(
		readonly session: AgentSession,
		readonly lineage: AssignmentLineage,
	) {
		this.api = {
			current: () => this.snapshot(this.lineage.getAssignment(this.id)),
			children: () =>
				this.lineage.children(this.id).flatMap(binding => {
					const child = this.find(binding.ref.childSessionId);
					const snapshot =
						(child && runtimes.get(child)?.snapshot(binding)) ??
						this.parkedSnapshots.get(binding.ref.childSessionId);
					return snapshot?.ref.assignmentId === binding.ref.assignmentId ? [snapshot] : [];
				}),
			subscribe: listener => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			},
			signal: (signal, count) => {
				const binding = this.lineage.getAssignment(this.id);
				if (!binding || binding.phase !== "running" || !Number.isSafeInteger(count) || count < 0) return;
				this.publish({ type: "signal", ref: binding.ref, signal, count });
			},
			remind: async (ref, requestId, content) => {
				if (this.disposed) return { outcome: "unavailable", reason: "parent-gone" };
				if (
					!requestId ||
					Buffer.byteLength(requestId) > 128 ||
					Buffer.byteLength(ref.assignmentId) > 128 ||
					Buffer.byteLength(ref.childSessionId) > 128 ||
					Buffer.byteLength(ref.parentSessionId) > 128 ||
					Buffer.byteLength(ref.parentBranchId) > 128 ||
					Buffer.byteLength(content) > 4096
				)
					return { outcome: "unavailable", reason: "handoff-failed" };
				const binding = this.lineage.getAssignment(ref.childSessionId);
				if (
					!binding ||
					ref.parentSessionId !== this.id ||
					!this.lineage.isCurrent(ref, binding.instanceId, binding.branchId)
				)
					return { outcome: "unavailable", reason: "stale-assignment" };
				if (binding.messaging.status !== "supported")
					return { outcome: "unavailable", reason: "messaging-disabled" };
				const registry = AgentRegistry.global();
				const from = registry.list().find(item => item.session === this.session)?.id;
				const to = registry
					.list()
					.find(item => item.session?.sessionManager.getSessionId() === ref.childSessionId)?.id;
				if (!from || !to) return { outcome: "unavailable", reason: "stale-instance" };
				const transport = {
					ref,
					branchId: binding.branchId,
					senderInstanceId: binding.parentInstanceId,
					recipientInstanceId: binding.instanceId,
					requestId,
				};
				const key = `${ref.assignmentId}:${requestId}`;
				const contentDigest = createHash("sha256").update(content).digest("hex");
				const previous = this.issuedIds.get(key);
				if (previous !== undefined)
					return !this.watches.get(key)?.pending && previous === contentDigest
						? { outcome: "duplicate" }
						: { outcome: "unavailable", reason: "handoff-failed" };
				this.issuedIds.set(key, contentDigest);
				const started = performance.now();
				const tick = () => {
					if (watch.reply !== undefined) return;
					const currentBinding = this.lineage.getAssignment(ref.childSessionId);
					if (
						!this.lineage.isCurrent(ref, binding.instanceId, binding.branchId) ||
						currentBinding?.messaging.status !== "supported"
					) {
						clearTimeout(watch.timer);
						watch.expired = true;
						return;
					}
					if (performance.now() - started >= 300_000) {
						watch.followUpSent = true;
						void IrcBus.global()
							.sendBound(
								{
									from,
									to,
									body: `Reply with a JSON ReportInput via irc send for check ${requestId}.`,
									assignmentId: ref.assignmentId,
									checkId: requestId,
								},
								transport,
							)
							.catch(() => {});
						return;
					}
					watch.rearm();
				};
				const rearm = () => {
					const remaining = Math.max(0, 300_000 - (performance.now() - started));
					watch.timer = setTimeout(tick, Math.min(15_000, remaining));
				};
				const watch = {
					timer: setTimeout(tick, 15_000),
					content: contentDigest,
					expired: false,
					pending: true,
					followUpSent: false,
					rearm,
					reply: undefined as string | undefined,
					replyDelivered: false,
				};
				const assignmentKeys = [...this.watches.keys()].filter(item => item.startsWith(`${ref.assignmentId}:`));
				if (assignmentKeys.length >= 64) {
					const oldest = assignmentKeys[0];
					if (oldest !== undefined) {
						clearInterval(this.watches.get(oldest)?.timer);
						this.watches.delete(oldest);
						this.issuedIds.delete(oldest);
					}
				}
				this.watches.set(key, watch);
				let receipt;
				try {
					receipt = await IrcBus.global().sendBound(
						{ from, to, body: content, assignmentId: ref.assignmentId, checkId: requestId },
						transport,
					);
				} catch {
					receipt = { outcome: "unavailable", reason: "handoff-failed" } as const;
				}
				watch.pending = false;
				if (
					receipt.outcome === "unavailable" ||
					!this.lineage.isCurrent(ref, binding.instanceId, binding.branchId)
				) {
					if (receipt.outcome === "unavailable" && this.watches.get(key) === watch) {
						this.issuedIds.delete(key);
						this.watches.delete(key);
					}
					clearTimeout(watch.timer);
					watch.expired = true;
				}
				return receipt;
			},
		};
		const stopPark = lineage.onPark(sessionId => {
			if (sessionId === this.id) {
				for (const watch of this.watches.values()) clearInterval(watch.timer);
				this.watches.clear();
				this.issuedIds.clear();
				return;
			}
			const binding = lineage.getAssignment(sessionId);
			if (!binding || binding.ref.parentSessionId !== this.id) return;
			const child = this.find(sessionId);
			const snapshot = child && runtimes.get(child)?.snapshot(binding);
			if (snapshot) this.parkedSnapshots.set(sessionId, { ...snapshot, phase: "paused" });
		});
		const stopResumeOrRelease = lineage.onResumeOrRelease(sessionId => {
			this.parkedSnapshots.delete(sessionId);
		});
		const stopTerminal = lineage.onTerminal(assignmentId => {
			for (const key of this.issuedIds.keys()) if (key.startsWith(`${assignmentId}:`)) this.issuedIds.delete(key);
			for (const [id, snapshot] of this.parkedSnapshots)
				if (snapshot.ref.assignmentId === assignmentId) this.parkedSnapshots.delete(id);
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
			if (
				snapshot &&
				(!previous ||
					snapshot.ref.assignmentId !== previous.ref.assignmentId ||
					snapshot.instanceId !== previous.instanceId ||
					snapshot.phase !== previous.phase ||
					snapshot.workTokens !== previous.workTokens ||
					snapshot.usagePartial !== previous.usagePartial ||
					snapshot.waitReasons.join(",") !== previous.waitReasons.join(",") ||
					snapshot.messaging.status !== previous.messaging.status)
			) {
				this.lastSnapshot = snapshot;
				this.publish({ type: "snapshot", snapshot });
			}
		});
		session.addDisposer(() => {
			this.disposed = true;
			unsubscribe();
			stopPark();
			stopResumeOrRelease();
			stopTerminal();
			for (const watch of this.watches.values()) clearInterval(watch.timer);
			this.watches.clear();
			this.issuedIds.clear();
			this.parkedSnapshots.clear();
			this.listeners.clear();
			runtimes.delete(session);
		});
	}

	get id(): string {
		return this.session.sessionManager.getSessionId();
	}

	find(id: string): AgentSession | undefined {
		return (
			AgentRegistry.global()
				.list()
				.find(item => item.session?.sessionManager.getSessionId() === id)?.session ?? undefined
		);
	}

	snapshot(binding: AssignmentBinding | undefined): AdvisorySnapshot | undefined {
		if (!binding || binding.ref.childSessionId !== this.id) return undefined;
		if (binding.ref.assignmentId !== this.assignmentId) return undefined;
		const values = this.adapter.source.snapshot(performance.now());
		if (!values) return undefined;
		return {
			ref: binding.ref,
			instanceId: binding.instanceId,
			phase: binding.phase,
			...values,
			messaging: binding.messaging,
			localCoverage: {
				edits: { status: "unavailable", reason: "detector-unregistered" },
				loops: { status: "unavailable", reason: "detector-unregistered" },
			},
		};
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
	if (!runtime) {
		runtime = new AdvisoryRuntime(session, lineage);
		runtimes.set(session, runtime);
	}
	return runtime.api;
}

export function receiveTaskAdvisory(session: AgentSession, message: IrcMessage): void {
	const binding = message.advisoryBinding;
	if (!binding || binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return;
	const runtime = runtimes.get(session);
	if (!runtime) return;
	const state = runtime.replyStates.get(message);
	if (!state || (binding.requestId && !runtime.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`)?.reply))
		return;
	runtime.replyStates.delete(message);
	if (binding.requestId) {
		const watch = runtime.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
		if (watch) {
			clearInterval(watch.timer);
			watch.replyDelivered = true;
		}
	}
	for (const listener of runtime.listeners)
		listener({
			type: "reply",
			ref: binding.ref,
			requestId: binding.requestId ?? "",
			senderInstanceId: binding.senderInstanceId,
			recipientInstanceId: binding.recipientInstanceId,
			state,
		});
}

export function admitTaskAdvisory(
	session: AgentSession,
	message: Omit<IrcMessage, "id" | "ts">,
	binding: NonNullable<IrcMessage["advisoryBinding"]>,
): "accept" | "duplicate" | "reject" {
	if (binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return "reject";
	const report = parseReportInput(message.body, binding.requestId);
	if (!report) return "reject";
	const runtime = runtimes.get(session);
	if (!runtime) return "reject";
	if (!binding.requestId) {
		runtime.replyStates.set(message, report.state);
		return "accept";
	}
	const watch = runtime.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
	if (!watch || watch.expired) return "reject";
	const digest = createHash("sha256").update(message.body).digest("hex");
	if (watch.reply !== undefined) return watch.replyDelivered && watch.reply === digest ? "duplicate" : "reject";
	clearInterval(watch.timer);
	watch.reply = digest;
	runtime.replyStates.set(message, report.state);
	return "accept";
}

export function rollbackTaskAdvisory(session: AgentSession, message: IrcMessage): void {
	const binding = message.advisoryBinding;
	const runtime = runtimes.get(session);
	runtime?.replyStates.delete(message);
	if (!binding?.requestId || binding.ref.parentSessionId !== session.sessionManager.getSessionId()) return;
	const watch = runtime?.watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
	if (watch) {
		watch.reply = undefined;
		watch.replyDelivered = false;
		if (!watch.expired && !watch.followUpSent) watch.rearm();
	}
}

export function createTaskAdvisoryForSessionId(id: string): TaskAdvisory | undefined {
	const session = AgentRegistry.global()
		.list()
		.find(item => item.session?.sessionManager.getSessionId() === id)?.session;
	return session ? runtimes.get(session)?.api : undefined;
}
