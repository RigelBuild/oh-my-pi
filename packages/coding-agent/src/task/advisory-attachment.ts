import type { TaskAdvisory } from "../extensibility/extensions/task-advisory";
import type { AgentSession } from "../session/agent-session";
import { AdvisoryHub, advisoryNow } from "./advisory-hub";
import { advisoryEventOf } from "./advisory-session-adapter";

const attachments = new Map<string, AdvisoryAttachment>();

export function taskAdvisoryFor(sessionId: string): TaskAdvisory | undefined {
	return attachments.get(sessionId)?.advisory;
}

/** Home-thread attachment for one session instance. */
export class AdvisoryAttachment {
	#key: { sessionId: string; instanceId: string } | undefined;
	readonly #unsubscribe: () => void;
	readonly #subscriptions = new Set<() => void>();
	readonly advisory: TaskAdvisory;

	constructor(private readonly session: AgentSession) {
		this.advisory = {
			contractVersion: 1,
			current: () => AdvisoryHub.global().current(session.sessionManager.getSessionId()),
			children: () => AdvisoryHub.global().children(session.sessionManager.getSessionId()),
			subscribe: listener => {
				const unsubscribe = AdvisoryHub.global().subscribe(session.sessionManager.getSessionId(), listener);
				this.#subscriptions.add(unsubscribe);
				return () => { this.#subscriptions.delete(unsubscribe); unsubscribe(); };
			},
			signal: (signal, count) => AdvisoryHub.global().signal(session.sessionManager.getSessionId(), signal, count),
			remind: (ref, requestId, content) => {
				const redacted = session.obfuscator?.obfuscate(content) ?? content;
				if (Buffer.byteLength(redacted) > 4096) return Promise.resolve({ outcome: "unavailable", reason: "handoff-failed" });
				return AdvisoryHub.global().remind({ parentSessionId: session.sessionManager.getSessionId(), ref, requestId, content: redacted });
			},
		};
		this.#unsubscribe = session.subscribe(event => {
			const key = this.#key;
			if (!key) return;
			const normalized = advisoryEventOf(event, advisoryNow());
			if (normalized) AdvisoryHub.global().publishEvent(key.sessionId, key.instanceId, normalized);
		});
	}

	reset(): void {
		this.#detach();
		const sessionId = this.session.sessionManager.getSessionId();
		const instanceId = crypto.randomUUID();
		this.#key = { sessionId, instanceId };
		attachments.set(sessionId, this);
		AdvisoryHub.global().attach({ sessionId, instanceId, agentId: this.session.getAgentId() });
	}

	#detach(): void {
		if (!this.#key) return;
		for (const unsubscribe of this.#subscriptions) unsubscribe();
		this.#subscriptions.clear();
		const { sessionId, instanceId } = this.#key;
		if (attachments.get(sessionId) === this) attachments.delete(sessionId);
		this.#key = undefined;
		AdvisoryHub.global().detach(sessionId, instanceId);
	}

	dispose(): void {
		this.#detach();
		this.#unsubscribe();
	}
}
