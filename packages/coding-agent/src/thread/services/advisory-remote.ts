import type { TaskAdvisoryEvent } from "../../extensibility/extensions/task-advisory";
import type { AdvisoryHubApi } from "../../task/advisory-hub";
import type { RemoteObject } from "../rpc";
import type { AdvisoryHubProtocol } from "./advisory-protocol";
import { localUnsubscribe } from "./support";

export class RemoteAdvisoryHub implements AdvisoryHubApi {
	readonly #remote: RemoteObject<AdvisoryHubProtocol>;
	readonly #listeners = new Map<string, { listeners: Set<(event: TaskAdvisoryEvent) => void>; close: () => void }>();
	constructor(remote: RemoteObject<AdvisoryHubProtocol>) {
		this.#remote = remote;
	}
	attach(input: Parameters<AdvisoryHubApi["attach"]>[0]) {
		this.#remote.callSync("attach", input);
	}
	detach(...args: Parameters<AdvisoryHubApi["detach"]>) {
		this.#remote.callSync("detach", ...args);
	}
	branch(...args: Parameters<AdvisoryHubApi["branch"]>) {
		return this.#remote.callSync("branch", ...args);
	}
	navigate(...args: Parameters<AdvisoryHubApi["navigate"]>) {
		this.#remote.callSync("navigate", ...args);
	}
	mint(...args: Parameters<AdvisoryHubApi["mint"]>) {
		return this.#remote.callSync("mint", ...args);
	}
	mintFollowUp(...args: Parameters<AdvisoryHubApi["mintFollowUp"]>) {
		return this.#remote.callSync("mintFollowUp", ...args);
	}
	wake(...args: Parameters<AdvisoryHubApi["wake"]>) {
		this.#remote.callSync("wake", ...args);
	}
	terminal(...args: Parameters<AdvisoryHubApi["terminal"]>) {
		this.#remote.callSync("terminal", ...args);
	}
	getAssignment(...args: Parameters<AdvisoryHubApi["getAssignment"]>) {
		return this.#remote.callSync("getAssignment", ...args);
	}
	current(...args: Parameters<AdvisoryHubApi["current"]>) {
		return this.#remote.callSync("current", ...args);
	}
	children(...args: Parameters<AdvisoryHubApi["children"]>) {
		return this.#remote.callSync("children", ...args);
	}
	publishEvent(...args: Parameters<AdvisoryHubApi["publishEvent"]>) {
		this.#remote.notify("publishEvent", ...args);
	}
	signal(...args: Parameters<AdvisoryHubApi["signal"]>) {
		this.#remote.notify("signal", ...args);
	}
	subscribe(sessionId: string, listener: (event: TaskAdvisoryEvent) => void): () => void {
		let entry = this.#listeners.get(sessionId);
		if (!entry) {
			const listeners = new Set<(event: TaskAdvisoryEvent) => void>();
			const close = localUnsubscribe(
				this.#remote.callSync("subscribe", sessionId, event => {
					for (const subscriber of [...listeners]) subscriber(event);
				}),
			);
			entry = { listeners, close };
			this.#listeners.set(sessionId, entry);
		}
		entry.listeners.add(listener);
		const current = entry;
		return () => {
			if (!current.listeners.delete(listener) || current.listeners.size) return;
			this.#listeners.delete(sessionId);
			current.close();
		};
	}
	remind(...args: Parameters<AdvisoryHubApi["remind"]>) {
		return this.#remote.call("remind", ...args);
	}
	sendBound(...args: Parameters<AdvisoryHubApi["sendBound"]>) {
		return this.#remote.call("sendBound", ...args);
	}
	validate(...args: Parameters<AdvisoryHubApi["validate"]>) {
		return this.#remote.callSync("validate", ...args);
	}
}
