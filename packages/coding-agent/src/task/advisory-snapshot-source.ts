import type { AdvisorySnapshot, WaitReason } from "../extensibility/extensions/task-advisory";

export type AdvisoryEvent =
	| { kind: "ready"; at: number }
	| { kind: "blocked-start"; at: number; token: string; reason: Exclude<WaitReason, "unknown"> }
	| { kind: "blocked-end"; at: number; token: string }
	| {
			kind: "assistant-usage";
			id: string;
			usage:
				| { input?: number; output?: number; cacheWrite?: number; cacheRead?: number; total?: number }
				| undefined;
	  };

export type AdvisorySourceSnapshot = Pick<
	AdvisorySnapshot,
	"wallMs" | "unblockedMs" | "waitReasons" | "workTokens" | "usagePartial"
>;

/** Accumulates normalized events in order and excludes the union of blocked intervals. */
export class AdvisorySnapshotSource {
	#readyAt: number | undefined;
	#blockedAt: number | undefined;
	#blockedMs = 0;
	#blocked = new Map<string, Exclude<WaitReason, "unknown">>();
	#ids = new Set<string>();
	#workTokens = 0;
	#usageKnown = false;
	#usagePartial = false;
	#usageDisabled = false;

	accept(event: AdvisoryEvent): void {
		if (event.kind === "ready") {
			this.#readyAt ??= event.at;
			return;
		}
		if (this.#readyAt === undefined) return;
		switch (event.kind) {
			case "blocked-start":
				if (this.#blocked.has(event.token)) break;
				if (this.#blocked.size === 0) this.#blockedAt = event.at;
				this.#blocked.set(event.token, event.reason);
				break;
			case "blocked-end":
				if (!this.#blocked.delete(event.token)) break;
				if (this.#blocked.size === 0 && this.#blockedAt !== undefined) {
					this.#blockedMs += event.at - this.#blockedAt;
					this.#blockedAt = undefined;
				}
				break;
			case "assistant-usage": {
				if (this.#ids.has(event.id)) break;
				this.#ids.add(event.id);
				const usage = event.usage;
				if (!usage || Object.values(usage).every(value => value === 0 || value === undefined)) {
					this.#usagePartial = true;
				} else if (
					usage.total !== undefined &&
					usage.input === undefined &&
					usage.output === undefined &&
					usage.cacheWrite === undefined
				) {
					this.#usageDisabled = true;
				} else {
					this.#usageKnown = true;
					this.#workTokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
				}
				break;
			}
		}
	}

	reload(events: readonly AdvisoryEvent[]): void {
		this.#readyAt = undefined;
		this.#blockedAt = undefined;
		this.#blockedMs = 0;
		this.#usageKnown = false;
		this.#blocked.clear();
		this.#ids.clear();
		this.#workTokens = 0;
		this.#usagePartial = false;
		this.#usageDisabled = false;
		for (const event of events) this.accept(event);
	}

	snapshot(now: number): AdvisorySourceSnapshot | undefined {
		if (this.#readyAt === undefined) return undefined;
		const wallMs = now - this.#readyAt;
		const blockedMs = this.#blockedMs + (this.#blockedAt === undefined ? 0 : now - this.#blockedAt);
		return {
			wallMs,
			unblockedMs: wallMs - blockedMs,
			waitReasons: [...new Set(this.#blocked.values())],
			workTokens: this.#usageDisabled || !this.#usageKnown ? null : this.#workTokens,
			usagePartial: this.#usagePartial || this.#usageDisabled || !this.#usageKnown,
		};
	}
}
