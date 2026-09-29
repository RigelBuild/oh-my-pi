import type { GatewayUsageEvent } from "@oh-my-pi/pi-ai/auth-gateway";

/** Wire shape of one Compass token-usage row; field names mirror the Server's TokenUsageEvent. */
export interface TokenUsageEvent {
	id: string;
	occurredAtUnixMs: number;
	agentAccountId: string;
	ownerUserId: string;
	sessionId: string;
	requestId: string;
	provider: string;
	model: string;
	credentialId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costMicroUsd: number;
	rateVersion: string;
	outcome: "ok" | "error" | "aborted";
}

export interface UsageAttribution {
	agentAccountId: string;
	ownerUserId: string;
	sessionId?: string;
}

export interface UsageTimer {
	cancel(): void;
}
export interface UsageEmitterOptions {
	/** Deliver one batch; reject to keep it buffered for retry. Ids repeat across retries. */
	send(batch: TokenUsageEvent[]): Promise<void>;
	attribute(event: GatewayUsageEvent): UsageAttribution | undefined;
	rateVersion: string;
	flushIntervalMs?: number;
	maxEvents?: number;
	maxAgeMs?: number;
	maxBatch?: number;
	retryBaseMs?: number;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => UsageTimer;
	clearTimer?: (timer: UsageTimer) => void;
	newId?: () => string;
	log?: { warn(msg: string, ctx?: object): void };
}

export interface UsageEmitter {
	onUsage(event: GatewayUsageEvent): void;
	flush(): Promise<void>;
	close(): Promise<void>;
	stats(): { buffered: number; dropped: number; unattributed: number; sent: number };
}

interface BufferedEvent {
	row: TokenUsageEvent;
	enqueuedAt: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_AGE_MS = 300_000;
const DEFAULT_MAX_BATCH = 500;
const DEFAULT_RETRY_BASE_MS = 1_000;

export function toTokenUsageEvent(
	e: GatewayUsageEvent,
	a: UsageAttribution,
	rateVersion: string,
	id: string,
): TokenUsageEvent {
	const usage = e.usage;
	const bucketTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const orchestration = usage.orchestration;
	const orchestrationTotal =
		(orchestration?.input ?? 0) + (orchestration?.cacheRead ?? 0) + (orchestration?.output ?? 0);
	const rawCost = Math.round(usage.cost.total * 1_000_000);
	return {
		id,
		occurredAtUnixMs: e.at,
		agentAccountId: a.agentAccountId,
		ownerUserId: a.ownerUserId,
		sessionId: a.sessionId ?? "",
		requestId: e.requestId,
		provider: e.provider,
		model: e.model,
		credentialId: e.account ?? "",
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		totalTokens: Math.max(usage.totalTokens, bucketTotal + orchestrationTotal),
		costMicroUsd: Number.isFinite(rawCost) ? Math.max(0, rawCost) : 0,
		rateVersion,
		outcome: e.outcome,
	};
}

export function createUsageEmitter(opts: UsageEmitterOptions): UsageEmitter {
	const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
	const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
	const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
	const now = opts.now ?? (() => performance.now());
	const newId = opts.newId ?? (() => crypto.randomUUID());
	const scheduleTimer =
		opts.setTimer ??
		((callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			timer.unref();
			return { cancel: () => clearTimeout(timer) };
		});
	const cancelTimer = opts.clearTimer ?? (timer => timer.cancel());
	const buffer: BufferedEvent[] = [];
	let dropped = 0;
	let unattributed = 0;
	let sent = 0;
	let warnedUnattributed = 0;
	let inFlight: Promise<void> | undefined;
	let failures = 0;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let timer: UsageTimer | undefined;
	const clearScheduled = (): void => {
		if (timer !== undefined) {
			cancelTimer(timer);
			timer = undefined;
		}
	};

	const schedule = (delayMs: number): void => {
		if (closed) return;
		clearScheduled();
		timer = scheduleTimer(() => {
			timer = undefined;
			void flush();
		}, delayMs);
	};

	const flush = (): Promise<void> => {
		if (inFlight) return inFlight;
		const attempt = async (): Promise<void> => {
			const cutoff = now() - maxAgeMs;
			let expired = 0;
			while (expired < buffer.length && buffer[expired]!.enqueuedAt < cutoff) expired++;
			if (expired > 0) {
				buffer.splice(0, expired);
				dropped += expired;
			}
			while (buffer.length > 0) {
				// Take the chunk out before awaiting so capacity eviction can't touch rows in flight.
				const chunk = buffer.splice(0, maxBatch);
				try {
					await opts.send(chunk.map(item => item.row));
				} catch (error) {
					failures++;
					buffer.unshift(...chunk);
					// Keep the retried chunk's ids; drop the oldest rows queued behind it instead.
					const excess = buffer.length - maxEvents;
					if (excess > 0) {
						buffer.splice(chunk.length, excess);
						dropped += excess;
					}
					try {
						opts.log?.warn("Compass usage batch send failed", { error, buffered: buffer.length });
					} catch {
						// Logging must not alter retry behavior.
					}
					const delay = Math.min(retryBaseMs * 2 ** (failures - 1), flushIntervalMs * 6);
					schedule(delay);
					return;
				}
				sent += chunk.length;
				failures = 0;
			}
			schedule(flushIntervalMs);
		};
		inFlight = attempt().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	};

	const emitter: UsageEmitter = {
		onUsage(event): void {
			if (closed) {
				dropped++;
				return;
			}
			try {
				const attribution = opts.attribute(event);
				if (!attribution?.agentAccountId || !attribution.ownerUserId) {
					droppedUnattributed();
					return;
				}
				buffer.push({ row: toTokenUsageEvent(event, attribution, opts.rateVersion, newId()), enqueuedAt: now() });
				while (buffer.length > maxEvents) {
					buffer.shift();
					dropped++;
				}
			} catch (error) {
				droppedUnattributed(error);
			}
		},
		flush,
		close(): Promise<void> {
			if (closePromise) return closePromise;
			closed = true;
			clearScheduled();
			closePromise = (async () => {
				await flush();
				// A caller may chain another flush onto the one close awaited; let it settle first.
				while (inFlight) await inFlight;
				clearScheduled();
				if (buffer.length > 0) {
					const remaining = buffer.length;
					try {
						opts.log?.warn("Dropping buffered Compass usage events on close", { count: remaining });
					} catch {
						// Logging must not prevent close from dropping unsent events.
					}
					buffer.length = 0;
					dropped += remaining;
				}
			})();
			return closePromise;
		},
		stats: () => ({ buffered: buffer.length, dropped, unattributed, sent }),
	};

	function droppedUnattributed(error?: unknown): void {
		unattributed++;
		if (unattributed % 100 !== 1 || warnedUnattributed === unattributed) return;
		warnedUnattributed = unattributed;
		try {
			opts.log?.warn(
				"Compass usage event could not be attributed",
				error === undefined ? { count: unattributed } : { count: unattributed, error },
			);
		} catch {
			// Logging must not escape the gateway usage hook.
		}
	}

	schedule(flushIntervalMs);
	return emitter;
}
