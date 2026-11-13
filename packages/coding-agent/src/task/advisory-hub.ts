import { createHash } from "node:crypto";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type {
	AdvisoryMessagingSupport,
	AdvisoryReceipt,
	AdvisorySnapshot,
	AdvisoryState,
	AssignmentRef,
	LocalSignal,
	TaskAdvisoryEvent,
} from "../extensibility/extensions/task-advisory";
import { IrcBus } from "../irc/bus";
import { isMainThread, type ThreadId } from "../thread/identity";
import { parseReportInput } from "./advisory-report";
import { AdvisorySnapshotSource, type AdvisoryEvent } from "./advisory-snapshot-source";
import { AssignmentLineage, type AdvisoryTransportBinding, type AssignmentBinding } from "./assignment-lineage";

export function advisoryNow(): number {
	return performance.timeOrigin + performance.now();
}
export interface AdvisoryAttach {
	sessionId: string;
	instanceId: string;
	agentId: string | undefined;
}
export interface AdvisoryCheck {
	fromAgentId: string;
	toAgentId: string;
	binding: AdvisoryTransportBinding;
}
export interface AdvisoryMint {
	childSessionId: string;
	parentSessionId: string;
	parentBranchId?: string;
	messaging: AdvisoryMessagingSupport;
}
export interface AdvisoryRemind {
	parentSessionId: string;
	ref: AssignmentRef;
	requestId: string;
	content: string;
}
export interface AdvisoryReply {
	childSessionId: string;
	fromAgentId: string;
	toAgentId: string;
	assignmentId: string;
	checkId?: string;
	body: string;
}
export interface AdvisoryHubApi {
	attach(input: AdvisoryAttach): void;
	detach(sessionId: string, instanceId: string): void;
	branch(sessionId: string): string;
	navigate(sessionId: string): void;
	mint(input: AdvisoryMint): AssignmentRef;
	mintFollowUp(childSessionId: string, parentAgentId: string): AssignmentRef | undefined;
	wake(sessionId: string): void;
	terminal(sessionId: string, assignmentId: string): void;
	getAssignment(sessionId: string): AssignmentBinding | undefined;
	current(sessionId: string): AdvisorySnapshot | undefined;
	children(parentSessionId: string): AdvisorySnapshot[];
	publishEvent(sessionId: string, instanceId: string, event: AdvisoryEvent): void;
	signal(sessionId: string, signal: LocalSignal, count: number): void;
	subscribe(sessionId: string, listener: (event: TaskAdvisoryEvent) => void): () => void;
	remind(input: AdvisoryRemind): Promise<AdvisoryReceipt>;
	sendBound(input: AdvisoryReply): Promise<AdvisoryReceipt>;
	validate(checks: readonly AdvisoryCheck[]): boolean[];
}

type Source = { assignmentId: string; source: AdvisorySnapshotSource; parkedAt?: number };
type Attached = AdvisoryAttach & { home: ThreadId };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validId = (id: string): boolean => id.length > 0 && Buffer.byteLength(id) <= 128;
const validRef = (ref: AssignmentRef): boolean =>
	[ref.assignmentId, ref.childSessionId, ref.parentSessionId, ref.parentBranchId].every(validId);
type Watch = {
	ref: AssignmentRef;
	content: string;
	started: number;
	timer?: NodeJS.Timeout;
	pending: boolean;
	expired: boolean;
	followUpSent: boolean;
	reply?: string;
	replyDelivered: boolean;
	rearm(): void;
};
/** All lineage and advisory state belongs to the main thread. */
export class AdvisoryHub implements AdvisoryHubApi {
	static #global: AdvisoryHubApi | undefined;
	static global(): AdvisoryHubApi {
		if (!this.#global) {
			if (!isMainThread()) throw new Error("Advisory hub not installed on worker");
			this.#global = new AdvisoryHub();
		}
		return this.#global;
	}
	static installGlobal(api: AdvisoryHubApi): void {
		this.#global = api;
	}
	static resetGlobalForTests(): void {
		this.#global = undefined;
	}
	static main(): AdvisoryHub {
		if (!isMainThread()) throw new Error("Advisory hub is main-thread only");
		const hub = this.global();
		if (!(hub instanceof AdvisoryHub)) throw new Error("Advisory hub is not main-owned");
		return hub;
	}
	readonly #lineage = new AssignmentLineage();
	readonly #sources = new Map<string, Source>();
	readonly #watches = new Map<string, Watch>();
	readonly #attached = new Map<string, Attached>();
	readonly #agents = new Map<string, string>();
	readonly #issued = new Map<string, string>();
	readonly #states = new Map<string, AdvisoryState>();
	readonly #suspended = new Map<string, string[]>();
	readonly #listeners = new Map<string, Set<(event: TaskAdvisoryEvent) => void>>();
	readonly #last = new Map<string, string>();
	/** Test-only resource counts for one session. */
	inspectForTests(sessionId: string): {
		attached: boolean;
		source: boolean;
		watches: number;
		timers: number;
		listeners: number;
	} {
		const watches = [...this.#watches.values()].filter(
			watch => watch.ref.childSessionId === sessionId || watch.ref.parentSessionId === sessionId,
		);
		return {
			attached: this.#attached.has(sessionId),
			source: this.#sources.has(sessionId),
			watches: watches.length,
			timers: watches.filter(watch => watch.timer !== undefined).length,
			listeners: this.#listeners.get(sessionId)?.size ?? 0,
		};
	}
	constructor() {
		if (!isMainThread()) throw new Error("Advisory hub is main-thread only");
		this.#lineage.onMint(ref => {
			this.#sources.set(ref.childSessionId, {
				assignmentId: ref.assignmentId,
				source: new AdvisorySnapshotSource(),
			});
			this.#last.delete(ref.childSessionId);
		});
		this.#lineage.onTerminal(id => this.#clearAssignment(id));
		this.#lineage.onPark(id => {
			const source = this.#sources.get(id);
			if (source) source.parkedAt = advisoryNow();
			this.#clearSession(id);
		});
		this.#lineage.onResumeOrRelease(id => {
			const source = this.#sources.get(id);
			if (source) delete source.parkedAt;
		});
	}
	attach(input: AdvisoryAttach): void {
		this.attachFrom("main", input);
	}
	attachFrom(home: ThreadId, input: AdvisoryAttach): void {
		const old = this.#attached.get(input.sessionId);
		if (old?.agentId && this.#agents.get(old.agentId) === input.sessionId) this.#agents.delete(old.agentId);
		this.#attached.set(input.sessionId, {
			sessionId: input.sessionId,
			instanceId: input.instanceId,
			agentId: input.agentId,
			home,
		});
		if (input.agentId) this.#agents.set(input.agentId, input.sessionId);
		this.#lineage.attach(input.sessionId, input.instanceId);
	}
	#remove(id: string): void {
		const entry = this.#attached.get(id);
		if (entry?.agentId && this.#agents.get(entry.agentId) === id) this.#agents.delete(entry.agentId);
		this.#attached.delete(id);
	}
	detach(id: string, instance: string): void {
		if (this.#attached.get(id)?.instanceId !== instance) return;
		this.#lineage.disposeSession(id, instance, "dispose");
		this.#remove(id);
		this.#prune();
	}
	parkSession(id: string): void {
		this.#lineage.parkSession(id);
		this.#remove(id);
	}
	parkAgent(agentId: string): string | undefined {
		const sessionId = this.#agents.get(agentId);
		if (sessionId) this.parkSession(sessionId);
		return sessionId;
	}
	expireParked(id: string): void {
		this.#lineage.expireParked(id);
		this.#prune();
	}
	disposeHome(home: ThreadId): void {
		for (const entry of this.#attached.values())
			if (entry.home === home) {
				this.#lineage.disposeSession(entry.sessionId, entry.instanceId, "dispose");
				this.#remove(entry.sessionId);
				this.#listeners.delete(entry.sessionId);
			}
		this.#prune();
	}
	#prune(): void {
		for (const [id, source] of this.#sources)
			if (this.#lineage.assignmentIdOf(id) !== source.assignmentId) {
				this.#sources.delete(id);
				this.#last.delete(id);
			}
	}
	branch(id: string): string {
		return this.#lineage.branch(id);
	}
	navigate(id: string): void {
		this.#lineage.navigate(id);
	}
	mint(input: AdvisoryMint): AssignmentRef {
		const ref = this.#lineage.mint(
			input.childSessionId,
			input.parentSessionId,
			input.parentBranchId,
			input.messaging,
		);
		const child = this.#attached.get(input.childSessionId);
		if (child) this.#lineage.attach(child.sessionId, child.instanceId);
		return ref;
	}
	mintFollowUp(childSessionId: string, parentAgentId: string): AssignmentRef | undefined {
		const parentSessionId = this.#agents.get(parentAgentId);
		if (!parentSessionId) return undefined;
		const messaging = this.#lineage.messagingOf(childSessionId);
		return this.mint({ childSessionId, parentSessionId, messaging: messaging ?? { status: "supported" } });
	}
	wake(id: string): void {
		this.#lineage.wake(id);
	}
	terminal(id: string, assignmentId: string): void {
		this.#lineage.terminal(id, assignmentId);
	}
	getAssignment(id: string): AssignmentBinding | undefined {
		return this.#lineage.getAssignment(id);
	}
	#snapshot(binding: AssignmentBinding): AdvisorySnapshot | undefined {
		const entry = this.#sources.get(binding.ref.childSessionId);
		if (!entry || entry.assignmentId !== binding.ref.assignmentId) return undefined;
		const values = entry.source.snapshot(entry.parkedAt ?? advisoryNow());
		if (!values) return undefined;
		return {
			ref: binding.ref,
			instanceId: binding.instanceId,
			phase: entry.parkedAt === undefined ? binding.phase : "paused",
			...values,
			messaging: binding.messaging,
			localCoverage: {
				edits: { status: "unavailable", reason: "detector-unregistered" },
				loops: { status: "unavailable", reason: "detector-unregistered" },
			},
		};
	}
	current(id: string): AdvisorySnapshot | undefined {
		const binding = this.#lineage.getAssignment(id);
		return binding && this.#snapshot(binding);
	}
	children(id: string): AdvisorySnapshot[] {
		return this.#lineage.children(id).flatMap(binding => {
			const snapshot = this.#snapshot(binding);
			return snapshot ? [snapshot] : [];
		});
	}
	publishEvent(id: string, instance: string, event: AdvisoryEvent): void {
		if (this.#attached.get(id)?.instanceId !== instance) return;
		const binding = this.#lineage.getAssignment(id);
		if (!binding || binding.phase !== "running") return;
		const source = this.#sources.get(id);
		if (!source || source.assignmentId !== binding.ref.assignmentId) return;
		source.source.accept(event);
		const snapshot = this.#snapshot(binding);
		if (!snapshot) return;
		const signature = JSON.stringify({ ...snapshot, wallMs: 0, unblockedMs: 0 });
		if (this.#last.get(id) !== signature) {
			this.#last.set(id, signature);
			const event: TaskAdvisoryEvent = { type: "snapshot", snapshot };
			this.#emit(id, event);
			this.#emit(binding.ref.parentSessionId, event);
		}
	}
	signal(id: string, signal: LocalSignal, count: number): void {
		if (!Number.isSafeInteger(count) || count < 0) return;
		const binding = this.#lineage.getAssignment(id);
		if (binding?.phase === "running") {
			const event: TaskAdvisoryEvent = { type: "signal", ref: binding.ref, signal, count };
			this.#emit(id, event);
			this.#emit(binding.ref.parentSessionId, event);
		}
	}
	subscribe(id: string, listener: (event: TaskAdvisoryEvent) => void): () => void {
		let listeners = this.#listeners.get(id);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(id, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.#listeners.delete(id);
		};
	}
	#emit(id: string, event: TaskAdvisoryEvent): void {
		for (const listener of this.#listeners.get(id) ?? []) listener(event);
	}
	validate(checks: readonly AdvisoryCheck[]): boolean[] {
		return checks.map(check => {
			const from = this.#agents.get(check.fromAgentId);
			const to = this.#agents.get(check.toAgentId);
			return !!from && !!to && !this.#lineage.validateBinding(check.binding, from, to, true);
		});
	}
	#failure(binding: AdvisoryTransportBinding, from: string, to: string) {
		const sender = this.#agents.get(from);
		const recipient = this.#agents.get(to);
		return sender && recipient ? this.#lineage.validateBinding(binding, sender, recipient) : "stale-instance";
	}
	async #deliver(from: string, to: string, body: string, binding: AdvisoryTransportBinding): Promise<AdvisoryReceipt> {
		const bus = IrcBus.global();
		if (!(bus instanceof IrcBus)) throw new Error("Bound delivery requires main IRC bus");
		const failure = () => this.#failure(binding, from, to);
		const initial = failure();
		if (initial) return { outcome: "unavailable", reason: initial };
		const receipt = await bus.deliverBound(
			{
				from,
				to,
				body,
				assignmentId: binding.ref.assignmentId,
				checkId: binding.requestId,
				advisoryBinding: binding,
			},
			{
				validate: failure,
				admit: message =>
					to === this.#attached.get(binding.ref.parentSessionId)?.agentId ? this.#admit(message) : "accept",
				received: message => {
					if (to === this.#attached.get(binding.ref.parentSessionId)?.agentId) this.#received(message);
				},
				rollback: message => {
					if (to === this.#attached.get(binding.ref.parentSessionId)?.agentId) this.#rollback(message);
				},
			},
		);
		return receipt.outcome === "failed"
			? { outcome: "unavailable", reason: failure() ?? "handoff-failed" }
			: { outcome: receipt.outcome };
	}
	async remind(input: AdvisoryRemind): Promise<AdvisoryReceipt> {
		const { ref, requestId, content } = input;
		if (!validRef(ref) || !validId(requestId) || Buffer.byteLength(content) > 4096)
			return { outcome: "unavailable", reason: "handoff-failed" };
		const binding = this.#lineage.getAssignment(ref.childSessionId);
		if (
			!binding ||
			input.parentSessionId !== ref.parentSessionId ||
			!this.#lineage.isCurrent(ref, binding.instanceId, binding.branchId)
		)
			return { outcome: "unavailable", reason: "stale-assignment" };
		if (binding.messaging.status !== "supported") return { outcome: "unavailable", reason: "messaging-disabled" };
		const from = this.#attached.get(ref.parentSessionId)?.agentId;
		const to = this.#attached.get(ref.childSessionId)?.agentId;
		if (!from || !to) return { outcome: "unavailable", reason: "stale-instance" };
		const key = `${ref.assignmentId}:${requestId}`;
		const digest = hash(content);
		const issued = this.#issued.get(key);
		if (issued !== undefined)
			return issued === digest && !this.#watches.get(key)?.pending
				? { outcome: "duplicate" }
				: { outcome: "unavailable", reason: "handoff-failed" };
		const keys = [...this.#watches.keys()].filter(id => id.startsWith(`${ref.assignmentId}:`));
		if (keys.length >= 64) {
			const oldest = keys[0];
			const prior = this.#watches.get(oldest);
			if (prior) clearTimeout(prior.timer);
			this.#watches.delete(oldest);
			this.#issued.delete(oldest);
		}
		const transport: AdvisoryTransportBinding = {
			ref,
			branchId: binding.branchId,
			senderInstanceId: binding.parentInstanceId,
			recipientInstanceId: binding.instanceId,
			requestId,
		};
		const watch = this.#createWatch(ref, requestId, digest, binding, transport, from, to);
		this.#issued.set(key, digest);
		this.#watches.set(key, watch);
		watch.rearm();
		let result: AdvisoryReceipt;
		try {
			result = await this.#deliver(from, to, content, transport);
		} catch {
			result = { outcome: "unavailable", reason: "handoff-failed" };
		}
		watch.pending = false;
		if (result.outcome === "unavailable") {
			clearTimeout(watch.timer);
			watch.timer = undefined;
			this.#watches.delete(key);
			this.#issued.delete(key);
		} else if (!this.#lineage.isCurrent(ref, binding.instanceId, binding.branchId)) {
			clearTimeout(watch.timer);
			watch.timer = undefined;
			watch.expired = true;
		}
		return result;
	}
	#createWatch(
		ref: AssignmentRef,
		requestId: string,
		digest: string,
		binding: AssignmentBinding,
		transport: AdvisoryTransportBinding,
		from: string,
		to: string,
	): Watch {
		const watch: Watch = {
			ref,
			content: digest,
			started: advisoryNow(),
			pending: true,
			expired: false,
			followUpSent: false,
			replyDelivered: false,
			rearm: () => {
				clearTimeout(watch.timer);
				watch.timer = setTimeout(tick, Math.min(15000, Math.max(0, 300000 - (advisoryNow() - watch.started))));
			},
		};
		const tick = () => {
			watch.timer = undefined;
			if (watch.reply !== undefined || watch.expired) return;
			const current = this.#lineage.getAssignment(ref.childSessionId);
			if (
				!this.#lineage.isCurrent(ref, binding.instanceId, binding.branchId) ||
				current?.messaging.status !== "supported"
			) {
				watch.expired = true;
				return;
			}
			if (advisoryNow() - watch.started >= 300000) {
				watch.followUpSent = true;
				void this.#deliver(
					from,
					to,
					`Reply with a JSON ReportInput via irc send for check ${requestId}.`,
					transport,
				).catch(() => {});
				return;
			}
			watch.rearm();
		};
		return watch;
	}
	async sendBound(input: AdvisoryReply): Promise<AdvisoryReceipt> {
		const binding = this.#lineage.getAssignment(input.childSessionId);
		if (
			!binding ||
			binding.ref.assignmentId !== input.assignmentId ||
			!validRef(binding.ref) ||
			!validId(input.fromAgentId) ||
			!validId(input.toAgentId) ||
			(input.checkId !== undefined && !validId(input.checkId)) ||
			Buffer.byteLength(input.body) > 4096 ||
			!parseReportInput(input.body, input.checkId)
		)
			return { outcome: "unavailable", reason: "stale-assignment" };
		if (
			this.#agents.get(input.fromAgentId) !== input.childSessionId ||
			this.#agents.get(input.toAgentId) !== binding.ref.parentSessionId
		)
			return { outcome: "unavailable", reason: "stale-instance" };
		if (binding.messaging.status !== "supported") return { outcome: "unavailable", reason: "messaging-disabled" };
		return this.#deliver(input.fromAgentId, input.toAgentId, input.body, {
			ref: binding.ref,
			branchId: binding.branchId,
			senderInstanceId: binding.instanceId,
			recipientInstanceId: binding.parentInstanceId,
			requestId: input.checkId,
		});
	}
	#admit(message: IrcMessage): "accept" | "duplicate" | "reject" {
		const binding = message.advisoryBinding;
		if (!binding) return "reject";
		const report = parseReportInput(message.body, binding.requestId);
		if (!report) return "reject";
		if (binding.requestId) {
			const watch = this.#watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
			if (!watch || watch.expired) return "reject";
			const digest = hash(message.body);
			if (watch.reply !== undefined) return watch.replyDelivered && watch.reply === digest ? "duplicate" : "reject";
			clearTimeout(watch.timer);
			watch.timer = undefined;
			watch.reply = digest;
		} else {
			const keys: string[] = [];
			for (const [key, watch] of this.#watches)
				if (key.startsWith(`${binding.ref.assignmentId}:`) && !watch.expired && watch.reply === undefined) {
					clearTimeout(watch.timer);
					watch.timer = undefined;
					keys.push(key);
				}
			this.#suspended.set(message.id, keys);
		}
		this.#states.set(message.id, report.state);
		return "accept";
	}
	#received(message: IrcMessage): void {
		const binding = message.advisoryBinding;
		const state = this.#states.get(message.id);
		if (!binding || !state) return;
		this.#states.delete(message.id);
		this.#suspended.delete(message.id);
		if (binding.requestId) {
			const watch = this.#watches.get(`${binding.ref.assignmentId}:${binding.requestId}`);
			if (!watch?.reply) return;
			watch.replyDelivered = true;
		}
		this.#emit(binding.ref.parentSessionId, {
			type: "reply",
			ref: binding.ref,
			requestId: binding.requestId ?? "",
			senderInstanceId: binding.senderInstanceId,
			recipientInstanceId: binding.recipientInstanceId,
			state,
		});
	}
	#rollback(message: IrcMessage): void {
		const binding = message.advisoryBinding;
		this.#states.delete(message.id);
		if (!binding) return;
		const keys = binding.requestId
			? [`${binding.ref.assignmentId}:${binding.requestId}`]
			: (this.#suspended.get(message.id) ?? []);
		this.#suspended.delete(message.id);
		for (const key of keys) {
			const watch = this.#watches.get(key);
			if (!watch || watch.expired || watch.followUpSent) continue;
			if (binding.requestId) {
				watch.reply = undefined;
				watch.replyDelivered = false;
			}
			if (watch.reply === undefined) watch.rearm();
		}
	}
	#clearAssignment(id: string): void {
		for (const [key, watch] of this.#watches)
			if (key.startsWith(`${id}:`)) {
				clearTimeout(watch.timer);
				this.#watches.delete(key);
				this.#issued.delete(key);
			}
	}
	#clearSession(id: string): void {
		for (const watch of this.#watches.values())
			if (watch.ref.parentSessionId === id || watch.ref.childSessionId === id)
				this.#clearAssignment(watch.ref.assignmentId);
	}
}
