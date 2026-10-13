import { randomUUID } from "node:crypto";
import type { GatewayErrorClassification } from "../error/gateway";
import { createProviderErrorMessage } from "../providers/error-message";
import { resolveWithThinkingLoopRetries, streamSimple } from "../stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "../types";
import { isMeaningfulCompletionEvent } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";

export { isMeaningfulCompletionEvent, resolveWithThinkingLoopRetries };

const MAX_PRECOMMIT_EVENTS = 256;

/** A candidate's identity in `FailoverContext.tried`: one backend serving one model. */
export function candidateKey(model: Model<Api>): string {
	return `${model.provider}\u0000${model.id}\u0000${model.baseUrl}`;
}

export interface AttemptBudget {
	/** Feed every event. A meaningful event lifts the budget; `done` or `error` disarms it. */
	observe(event: AssistantMessageEvent): void;
	/** Disarms the budget and clears its timer. Call when the attempt settles or throws. */
	settle(): void;
	/** Re-arms a lifted budget to its original `endsAt` before an internal redispatch, firing it at once if that has passed; no-op once settled or fired. */
	rearm?(): void;
	/** True only if the budget abort fired before any lift, terminal event, or `settle()`. */
	timedOut(): boolean;
}

/** Armed by the loop immediately before `streamSimple`. Aborts `attempt` at `endsAt` unless lifted or disarmed first. `undefined` never fires. */
export function armBudget(attempt: AbortController, endsAt: number | undefined): AttemptBudget {
	let active = false;
	let settled = false;
	let timeoutFired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const disarm = (): void => {
		active = false;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	const fire = (): void => {
		active = false;
		if (attempt.signal.aborted) return;
		timeoutFired = true;
		attempt.abort(new Error("Gateway attempt budget expired"));
	};
	const arm = (): void => {
		if (endsAt === undefined || active || settled || timeoutFired || attempt.signal.aborted) return;
		active = true;
		timer = setTimeout(
			() => {
				timer = undefined;
				if (active) fire();
			},
			Math.max(0, endsAt - Date.now()),
		);
	};
	arm();

	return {
		observe(event) {
			if (isMeaningfulCompletionEvent(event)) {
				disarm();
			} else if (event.type === "done" || event.type === "error") {
				disarm();
			}
		},
		settle: () => {
			settled = true;
			disarm();
		},
		rearm: () => {
			// A redispatch past the window would start unbudgeted; expire it before it begins.
			if (endsAt !== undefined && endsAt <= Date.now() && !settled && !timeoutFired) fire();
			else arm();
		},
		timedOut: () => timeoutFired,
	};
}

export type HeldAttempt =
	| { readonly kind: "committed"; readonly relay: AssistantMessageEventStream }
	| { readonly kind: "failed"; readonly relay: AssistantMessageEventStream; readonly error: AssistantMessage };

/** Streaming: buffers until a meaningful event or `done` (committed) or an `error` (failed). */
export function holdUntilCommit(events: AssistantMessageEventStream, budget: AttemptBudget): Promise<HeldAttempt> {
	const relay = new AssistantMessageEventStream();
	const buffered: AssistantMessageEvent[] = [];
	const { promise, resolve, reject } = Promise.withResolvers<HeldAttempt>();
	let committed = false;
	let resolved = false;
	const flush = (): void => {
		for (const event of buffered) relay.push(event);
		buffered.length = 0;
	};
	const commit = (): void => {
		committed = true;
		flush();
		if (!resolved) {
			resolved = true;
			resolve({ kind: "committed", relay });
		}
	};

	void (async () => {
		try {
			for await (const event of events) {
				budget.observe(event);
				if (event.type === "error") {
					if (!committed) {
						resolved = true;
						resolve({ kind: "failed", relay, error: event.error });
						return;
					}
					relay.push(event);
					return;
				}
				if (event.type === "done") {
					if (!committed) commit();
					relay.push(event);
					return;
				}
				if (!committed && !isMeaningfulCompletionEvent(event)) {
					if (buffered.length === MAX_PRECOMMIT_EVENTS) {
						const error: AssistantMessage = {
							...event.partial,
							content: [],
							stopReason: "error",
							errorMessage: "Too many events before candidate output.",
							errorClassificationMessage: "Too many events before candidate output.",
							errorStatus: 502,
						};
						buffered.length = 0;
						resolved = true;
						resolve({ kind: "failed", relay, error });
						return;
					}
					buffered.push(event);
					continue;
				}
				if (!committed) commit();
				relay.push(event);
			}
			const message = await events.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				if (!committed) {
					if (!resolved) {
						resolved = true;
						resolve({ kind: "failed", relay, error: message });
					}
				} else {
					relay.push({
						type: "error",
						reason: message.stopReason,
						error: message,
					});
				}
				return;
			}
			if (!committed) commit();
			if (!relay.done) relay.end(message);
		} catch (error) {
			if (committed) relay.fail(error);
			else if (!resolved) {
				resolved = true;
				reject(error);
			}
		} finally {
			budget.settle();
		}
	})();

	return promise;
}

/**
 * Drain like `completeSimple`; retries reuse the session ID to preserve provider state.
 * The first dispatch runs eagerly so a synchronous `streamSimple` throw escapes as a setup failure.
 */
export function completeAttempt(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	budget: AttemptBudget,
): Promise<AssistantMessage> {
	const sessionOptions = options.sessionId ? options : { ...options, sessionId: randomUUID() };
	const dispatch = (): AssistantMessageEventStream => {
		const events = streamSimple(model, context, sessionOptions);
		const relay = new AssistantMessageEventStream();
		void (async () => {
			try {
				for await (const event of events) {
					budget.observe(event);
					relay.push(event);
				}
				const message = await events.result();
				if (!relay.done) relay.end(message);
			} catch (error) {
				relay.fail(error);
			}
		})();
		return relay;
	};
	let first: AssistantMessageEventStream | undefined = dispatch();
	const result = resolveWithThinkingLoopRetries(sessionOptions.signal, () => {
		if (first) {
			const events = first;
			first = undefined;
			return events;
		}
		// Deltas before the loop error lifted the budget; a stalled redispatch must still reach the follower.
		budget.rearm?.();
		// A budget that expired during the retry wait aborted the attempt; starting the call would waste it.
		sessionOptions.signal?.throwIfAborted();
		return dispatch();
	});
	return result.finally(() => budget.settle());
}

/** Ends `relay` with an `error` event carrying `failure`; used once headers are sent. */
export function endWithFailure(
	relay: AssistantMessageEventStream,
	model: Model<Api>,
	failure: GatewayErrorClassification,
): void {
	const error: AssistantMessage = {
		...createProviderErrorMessage(model, failure.message),
		errorClassificationMessage: failure.message,
		errorStatus: failure.status,
	};
	relay.push({ type: "error", reason: "error", error });
}

/** Keep intermediaries alive while a candidate is held before its first content. */
export function sseHoldBody(
	body: Promise<ReadableStream<Uint8Array>>,
	onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let cancelled = false;
	let cancelReason: unknown;
	let cancelReader: ((reason: unknown) => Promise<void>) | undefined;
	let cancelStream: ((reason: unknown) => Promise<void>) | undefined;
	let cancelInvoked = false;
	let readBody: (() => Promise<{ done: boolean; value?: Uint8Array }>) | undefined;
	let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
	let signalCancel: () => void = () => {};
	const cancelPromise = new Promise<void>(resolve => {
		signalCancel = resolve;
	});
	const bodyResult = body.then(
		stream => {
			cancelStream = reason => stream.cancel(reason);
			return { kind: "body" as const, stream };
		},
		error => ({ kind: "error" as const, error }),
	);
	const cancelBody = (reason: unknown): Promise<void> | undefined => {
		if (cancelInvoked) return;
		const cancel = cancelReader ?? cancelStream;
		if (!cancel) return;
		cancelInvoked = true;
		return cancel(reason);
	};

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (cancelled) return;
				try {
					if (!readBody) {
						const keepalive = new Promise<{ kind: "keepalive" }>(resolve => {
							keepaliveTimer = setTimeout(() => resolve({ kind: "keepalive" }), 15_000);
						});
						const result = await Promise.race([
							bodyResult,
							keepalive,
							cancelPromise.then(() => ({ kind: "cancel" as const })),
						]);
						if (keepaliveTimer !== undefined) {
							clearTimeout(keepaliveTimer);
							keepaliveTimer = undefined;
						}
						if (cancelled || result.kind === "cancel") return;
						if (result.kind === "keepalive") {
							controller.enqueue(encoder.encode(": keepalive\n\n"));
							return;
						}
						if (result.kind === "error") {
							controller.error(result.error);
							return;
						}
						cancelStream = reason => result.stream.cancel(reason);
						if (cancelled) {
							void cancelBody(cancelReason)?.catch(() => {});
							return;
						}
						const reader = result.stream.getReader();
						cancelReader = reason => reader.cancel(reason);
						cancelStream = undefined;
						readBody = async () => {
							const next = await reader.read();
							return { done: next.done, value: next.value };
						};
					}

					const next = await readBody();
					if (cancelled) return;
					if (next.done) controller.close();
					else if (next.value !== undefined) controller.enqueue(next.value);
				} catch (error) {
					if (!cancelled) controller.error(error);
				}
			},
			cancel(reason) {
				cancelled = true;
				cancelReason = reason;
				clearTimeout(keepaliveTimer);
				signalCancel();
				onCancel(reason);
				const cancellation = cancelBody(reason);
				if (cancellation) return cancellation;
				void bodyResult
					.then(result => {
						if (result.kind === "body") return cancelBody(reason);
					})
					.catch(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
}
