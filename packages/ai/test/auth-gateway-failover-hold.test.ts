import { afterEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { scheduler } from "node:timers/promises";
import {
	armBudget,
	completeAttempt,
	holdUntilCommit,
	sseHoldBody,
	type AttemptBudget,
} from "@oh-my-pi/pi-ai/auth-gateway/failover";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
});

function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function streamEvent(type: "start" | "text_start" | "text_delta", delta = ""): AssistantMessageEvent {
	const partial = message();
	if (type === "start") return { type, partial };
	if (type === "text_start") return { type, contentIndex: 0, partial };
	return { type, contentIndex: 0, delta, partial };
}

async function readAll(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("auth-gateway failover hold primitives", () => {
	it("replays buffered events in order at the first meaningful event", async () => {
		const source = new AssistantMessageEventStream();
		const held = holdUntilCommit(source, armBudget(new AbortController(), undefined));
		source.push(streamEvent("start"));
		source.push(streamEvent("text_start"));
		source.push(streamEvent("text_delta", "hello"));
		const attempt = await held;
		expect(attempt.kind).toBe("committed");
		if (attempt.kind !== "committed") throw new Error("expected committed attempt");
		source.push({ type: "done", reason: "stop", message: message() });
		expect((await readAll(attempt.relay)).map(event => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"done",
		]);
	});

	it("forwards errors that arrive after commit", async () => {
		const source = new AssistantMessageEventStream();
		const held = holdUntilCommit(source, armBudget(new AbortController(), undefined));
		source.push(streamEvent("text_delta", "visible"));
		const attempt = await held;
		if (attempt.kind !== "committed") throw new Error("expected committed attempt");
		const failure = message("error");
		failure.errorMessage = "later provider failure";
		source.push({ type: "error", reason: "error", error: failure });
		const replayed = await readAll(attempt.relay);
		expect(replayed.at(-1)).toEqual({ type: "error", reason: "error", error: failure });
	});

	it("fails before commit after only start and empty text_start events", async () => {
		const source = new AssistantMessageEventStream();
		const held = holdUntilCommit(source, armBudget(new AbortController(), undefined));
		source.push(streamEvent("start"));
		source.push(streamEvent("text_start"));
		const failure = message("error");
		failure.errorMessage = "failed before output";
		source.push({ type: "error", reason: "error", error: failure });
		const attempt = await held;
		expect(attempt).toMatchObject({ kind: "failed", error: failure });
	});
	it("commits on done before meaningful output and replays buffered events", async () => {
		const source = new AssistantMessageEventStream();
		const held = holdUntilCommit(source, armBudget(new AbortController(), undefined));
		source.push(streamEvent("start"));
		source.push({ type: "done", reason: "stop", message: message() });
		const attempt = await held;
		expect(attempt.kind).toBe("committed");
		if (attempt.kind !== "committed") throw new Error("expected committed attempt");
		expect((await readAll(attempt.relay)).map(event => event.type)).toEqual(["start", "done"]);
	});

	it("fails if the source ends with an error result but no terminal event", async () => {
		const source = new AssistantMessageEventStream();
		const held = holdUntilCommit(source, armBudget(new AbortController(), undefined));
		const failure = message("error");
		source.end(failure);
		expect(await held).toMatchObject({ kind: "failed", error: failure });
	});
	it.each(["error", "aborted"] as const)(
		"fails on a result-only %s before commit and terminates after commit",
		async stopReason => {
			const failedSource = new AssistantMessageEventStream();
			const failedHold = holdUntilCommit(failedSource, armBudget(new AbortController(), undefined));
			const failure = message(stopReason);
			failure.errorMessage = `provider ${stopReason}`;
			failedSource.end(failure);
			expect(await failedHold).toMatchObject({ kind: "failed", error: failure });

			const committedSource = new AssistantMessageEventStream();
			const committedHold = holdUntilCommit(committedSource, armBudget(new AbortController(), undefined));
			committedSource.push(streamEvent("text_delta", "visible"));
			const attempt = await committedHold;
			if (attempt.kind !== "committed") throw new Error("expected committed attempt");
			committedSource.end(failure);
			expect(await readAll(attempt.relay)).toContainEqual({ type: "error", reason: stopReason, error: failure });
		},
	);

	it("fails and releases buffered events when precommit lifecycle events exceed the cap", async () => {
		const source = new AssistantMessageEventStream();
		const held = holdUntilCommit(source, armBudget(new AbortController(), undefined));
		for (let index = 0; index < 257; index++) source.push(streamEvent("start"));
		const attempt = await held;
		expect(attempt.kind).toBe("failed");
		if (attempt.kind !== "failed") throw new Error("expected bounded-buffer failure");
		expect(attempt.error).toMatchObject({
			stopReason: "error",
			errorMessage: "Too many events before candidate output.",
			errorClassificationMessage: "Too many events before candidate output.",
			errorStatus: 502,
		});
	});

	it("aborts on a silent budget expiry and reports the timeout", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const attempt = new AbortController();
		const budget = armBudget(attempt, Date.now() + 100);
		vi.advanceTimersByTime(100);
		expect(attempt.signal.aborted).toBe(true);
		expect(budget.timedOut()).toBe(true);
	});

	it("does not arm a timeout for an undefined deadline", () => {
		vi.useFakeTimers();
		const attempt = new AbortController();
		const budget = armBudget(attempt, undefined);
		vi.advanceTimersByTime(100_000);
		expect(attempt.signal.aborted).toBe(false);
		expect(budget.timedOut()).toBe(false);
	});

	it("does not attribute a caller abort to a later budget expiry", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const attempt = new AbortController();
		const budget = armBudget(attempt, Date.now() + 100);
		attempt.abort(new Error("caller cancelled"));
		vi.advanceTimersByTime(100);
		expect(budget.timedOut()).toBe(false);
	});

	it("lifts the budget after a meaningful event", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const attempt = new AbortController();
		const budget = armBudget(attempt, Date.now() + 100);
		budget.observe(streamEvent("text_delta", "content"));
		vi.advanceTimersByTime(100);
		expect(attempt.signal.aborted).toBe(false);
		expect(budget.timedOut()).toBe(false);
	});

	it.each(["done", "error", "settle"] as const)("does not time out after %s disarms the budget", action => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const attempt = new AbortController();
		const budget = armBudget(attempt, Date.now() + 100);
		if (action === "settle") budget.settle();
		else if (action === "done") budget.observe({ type: "done", reason: "stop", message: message() });
		else budget.observe({ type: "error", reason: "error", error: message("error") });
		vi.advanceTimersByTime(100);
		expect(attempt.signal.aborted).toBe(false);
		expect(budget.timedOut()).toBe(false);
	});

	it("lifts the budget through the hold and keeps forwarding after its deadline", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const source = new AssistantMessageEventStream();
		const attemptController = new AbortController();
		const budget = armBudget(attemptController, Date.now() + 100);
		const held = holdUntilCommit(source, budget);
		source.push(streamEvent("text_delta", "content"));
		const attempt = await held;
		if (attempt.kind !== "committed") throw new Error("expected committed attempt");
		vi.advanceTimersByTime(100);
		expect(attemptController.signal.aborted).toBe(false);
		source.push(streamEvent("text_delta", " later"));
		expect((await attempt.relay[Symbol.asyncIterator]().next()).value?.type).toBe("text_delta");
		expect((await attempt.relay[Symbol.asyncIterator]().next()).value).toMatchObject({
			type: "text_delta",
			delta: " later",
		});
		source.push({ type: "done", reason: "stop", message: message() });
	});

	it("writes keepalive comments before the held body bytes", async () => {
		vi.useFakeTimers();
		const body = Promise.withResolvers<ReadableStream<Uint8Array>>();
		const held = sseHoldBody(body.promise, () => {});
		const reader = held.getReader();
		const commentRead = reader.read();
		await Promise.resolve();
		vi.advanceTimersByTime(15_000);
		expect(new TextDecoder().decode((await commentRead).value)).toBe(": keepalive\n\n");
		const secondCommentRead = reader.read();
		await Promise.resolve();
		vi.advanceTimersByTime(15_000);
		expect(new TextDecoder().decode((await secondCommentRead).value)).toBe(": keepalive\n\n");
		body.resolve(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
					controller.close();
				},
			}),
		);
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n");
		expect((await reader.read()).done).toBe(true);
	});

	it("calls onCancel when the held response body is cancelled", async () => {
		const body = Promise.withResolvers<ReadableStream<Uint8Array>>();
		const onCancel = vi.fn();
		const reader = sseHoldBody(body.promise, onCancel).getReader();
		await reader.cancel("client disconnected");
		expect(onCancel).toHaveBeenCalledWith("client disconnected");
	});
	it("cancels a body that resolves after the client disconnects", async () => {
		const body = Promise.withResolvers<ReadableStream<Uint8Array>>();
		const cancel = Promise.withResolvers<void>();
		let cancelStarted = false;
		const reader = sseHoldBody(body.promise, () => {}).getReader();
		await reader.cancel("client disconnected");
		body.resolve(
			new ReadableStream<Uint8Array>({
				cancel(reason) {
					expect(reason).toBe("client disconnected");
					cancelStarted = true;
					return cancel.promise;
				},
			}),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(cancelStarted).toBe(true);
		cancel.resolve();
	});
	it("cancels a body that resolves after the downstream pull is cancelled", async () => {
		const body = Promise.withResolvers<ReadableStream<Uint8Array>>();
		const cancellation = Promise.withResolvers<void>();
		const reader = sseHoldBody(body.promise, () => {}).getReader();
		void reader.read();
		await Promise.resolve();
		await reader.cancel("race disconnect");
		body.resolve(
			new ReadableStream<Uint8Array>({
				cancel(reason) {
					expect(reason).toBe("race disconnect");
					cancellation.resolve();
				},
			}),
		);
		await cancellation.promise;
	});

	it("reads a body chunk only when downstream requests it", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array([pulls]));
				},
			},
			{ highWaterMark: 0 },
		);
		const reader = sseHoldBody(Promise.resolve(body), () => {}).getReader();
		await scheduler.yield();
		expect(pulls).toBe(0);
		expect(Array.from((await reader.read()).value ?? [])).toEqual([1]);
		expect(pulls).toBe(1);
		await reader.cancel("done");
	});
	it("propagates cancellation to an acquired body reader", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
			},
			cancel,
		});
		const reader = sseHoldBody(Promise.resolve(body), () => {}).getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n");
		await reader.cancel("downstream stopped");
		expect(cancel).toHaveBeenCalledWith("downstream stopped");
	});

	it("drains completion events through the shared attempt budget", async () => {
		registerMockApi();
		try {
			const mock = createMockModel({ responses: [{ content: ["answer"] }] });
			const observed: AssistantMessageEvent["type"][] = [];
			let settled = false;
			const budget: AttemptBudget = {
				observe(event) {
					observed.push(event.type);
				},
				settle() {
					settled = true;
				},
				timedOut: () => false,
			};
			const result = await completeAttempt(mock.model, { messages: [] }, { apiKey: "test-key" }, budget);
			expect(result.content).toEqual([{ type: "text", text: "answer" }]);
			expect(observed).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
			expect(settled).toBe(true);
		} finally {
			clearCustomApis();
		}
	});
	it("keeps the session ID and observes each thinking-loop redispatch", async () => {
		registerMockApi();
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const cycle =
				"% shipped. 100% delivered. 100% verified. 100% validated. 100% approved. 100% accepted. 100% merged. 100% deployed. 100% live. 100% operational. 100% successful. 100% excellent. 100% perfect. 100% final. 100% absolute. 100% total. 100% whole. 100% full. 100% entire. 100% complete. 100% done. 100% finished. 100";
			const mock = createMockModel({
				provider: "kiro",
				id: "gpt-5-6-sol",
				responses: [{ content: [`Healthy lead sentence. ${cycle.repeat(6)}`] }, { content: ["answer"] }],
			});
			const observed: AssistantMessageEvent["type"][] = [];
			const budget: AttemptBudget = {
				observe(event) {
					observed.push(event.type);
				},
				settle() {},
				timedOut: () => false,
			};
			const result = await completeAttempt(mock.model, { messages: [] }, { apiKey: "test-key" }, budget);
			expect(result.content).toEqual([{ type: "text", text: "answer" }]);
			expect(mock.calls).toHaveLength(2);
			expect(mock.calls[0]?.options?.sessionId).toBe(mock.calls[1]?.options?.sessionId);
			expect(observed.filter(type => type === "start")).toHaveLength(2);
			expect(observed).toContain("error");
			expect(observed).toContain("done");
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});
});
