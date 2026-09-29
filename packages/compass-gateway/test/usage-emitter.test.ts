import { describe, expect, it, spyOn } from "bun:test";
import type { GatewayUsageEvent } from "@oh-my-pi/pi-ai/auth-gateway";
import { createUsageEmitter, toTokenUsageEvent, type TokenUsageEvent } from "../src/usage-emitter";

const event = (overrides: Partial<GatewayUsageEvent> = {}): GatewayUsageEvent => ({
	requestId: "request-1",
	provider: "provider",
	model: "model",
	usage: {
		input: 2,
		output: 3,
		cacheRead: 4,
		cacheWrite: 5,
		totalTokens: 8,
		orchestration: { input: 2, cacheRead: 1, output: 1 },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000015 },
	},
	outcome: "ok",
	at: 123,
	client: { installId: "client-id" },
	...overrides,
});
const attribution = { agentAccountId: "agent", ownerUserId: "owner", sessionId: "session" };

class Clock {
	time = 1_000;
	next = 0;
	timers = new Map<number, { callback: () => void; delay: number }>();
	now = (): number => this.time;
	setTimer = (callback: () => void, delay: number): { cancel(): void } => {
		const id = ++this.next;
		this.timers.set(id, { callback, delay });
		return { cancel: () => this.timers.delete(id) };
	};
	clearTimer = (timer: { cancel(): void }): void => {
		timer.cancel();
	};

	fireNext(): number {
		const entry = this.timers.entries().next().value;
		if (!entry) throw new Error("No timer scheduled");
		const [id, timer] = entry;
		this.timers.delete(id);
		this.time += timer.delay;
		timer.callback();
		return timer.delay;
	}
}

function options(
	clock: Clock,
	send: (batch: TokenUsageEvent[]) => Promise<void>,
	overrides: Partial<Parameters<typeof createUsageEmitter>[0]> = {},
) {
	return {
		send,
		attribute: () => attribution,
		rateVersion: "rates-1",
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		newId: (() => {
			let id = 0;
			return () => `id-${++id}`;
		})(),
		...overrides,
	};
}

describe("Compass usage emitter", () => {
	it("maps all fields, rounds cost, and applies the total-token floor", () => {
		const mapped = toTokenUsageEvent(event({ account: "credential" }), attribution, "rates-1", "stable-id");
		expect(mapped).toEqual({
			id: "stable-id",
			occurredAtUnixMs: 123,
			agentAccountId: "agent",
			ownerUserId: "owner",
			sessionId: "session",
			requestId: "request-1",
			provider: "provider",
			model: "model",
			credentialId: "credential",
			inputTokens: 2,
			outputTokens: 3,
			cacheReadTokens: 4,
			cacheWriteTokens: 5,
			totalTokens: 18,
			costMicroUsd: 2,
			rateVersion: "rates-1",
			outcome: "ok",
		});
		expect(
			toTokenUsageEvent(event({ account: undefined }), { agentAccountId: "a", ownerUserId: "o" }, "r", "i")
				.credentialId,
		).toBe("");
		expect(toTokenUsageEvent(event(), { agentAccountId: "a", ownerUserId: "o" }, "r", "i").sessionId).toBe("");
		expect(
			toTokenUsageEvent(
				event({ usage: { ...event().usage, totalTokens: 30, cost: { ...event().usage.cost, total: Number.NaN } } }),
				attribution,
				"r",
				"i",
			),
		).toMatchObject({ totalTokens: 30, costMicroUsd: 0 });
	});

	it("sends ordered chunks and retries failed ids unchanged", async () => {
		const clock = new Clock();
		const batches: string[][] = [];
		let fail = true;
		const emitter = createUsageEmitter(
			options(
				clock,
				async batch => {
					batches.push(batch.map(item => item.id));
					if (fail) {
						fail = false;
						throw new Error("offline");
					}
				},
				{ maxBatch: 2 },
			),
		);
		for (let index = 0; index < 3; index++) emitter.onUsage(event({ requestId: `r${index}` }));
		await emitter.flush();
		expect(batches).toEqual([["id-1", "id-2"]]);
		expect(clock.fireNext()).toBe(1_000);
		await emitter.flush();
		expect(batches).toEqual([["id-1", "id-2"], ["id-1", "id-2"], ["id-3"]]);
		expect(emitter.stats()).toMatchObject({ buffered: 0, sent: 3 });
		await emitter.close();
	});

	it("drops oldest at capacity and expires old entries when flushed", async () => {
		const clock = new Clock();
		const sent: string[] = [];
		const emitter = createUsageEmitter(
			options(
				clock,
				async batch => {
					sent.push(...batch.map(row => row.id));
				},
				{ maxEvents: 2, maxAgeMs: 50, flushIntervalMs: 10 },
			),
		);
		for (let index = 0; index < 3; index++) emitter.onUsage(event());
		expect(emitter.stats()).toMatchObject({ buffered: 2, dropped: 1 });
		clock.time += 51;
		await emitter.flush();
		expect(sent).toEqual([]);
		expect(emitter.stats()).toMatchObject({ buffered: 0, dropped: 3 });
		await emitter.close();
	});

	it("backs off exponentially, caps delay, and resets after success", async () => {
		const clock = new Clock();
		let attempts = 0;
		const emitter = createUsageEmitter(
			options(
				clock,
				async () => {
					if (++attempts < 4) throw new Error("offline");
				},
				{ retryBaseMs: 100, flushIntervalMs: 50 },
			),
		);
		emitter.onUsage(event());
		await emitter.flush();
		expect(clock.fireNext()).toBe(100);
		await emitter.flush();
		expect(clock.fireNext()).toBe(200);
		await emitter.flush();
		expect(clock.fireNext()).toBe(300);
		await emitter.flush();
		expect(attempts).toBe(4);
		emitter.onUsage(event());
		await emitter.flush();
		expect(clock.timers.values().next().value?.delay).toBe(50);
		await emitter.close();
	});

	it("contains attribution failures and never buffers unattributed events", async () => {
		const clock = new Clock();
		let warns = 0;
		const emitter = createUsageEmitter(
			options(clock, async () => {}, {
				attribute: (item: GatewayUsageEvent) => {
					if (item.requestId === "throws") throw new Error("bad identity");
					return undefined;
				},
				log: {
					warn: () => {
						warns++;
					},
				},
			}),
		);
		expect(() => emitter.onUsage(event())).not.toThrow();
		expect(() => emitter.onUsage(event({ requestId: "throws" }))).not.toThrow();
		expect(warns).toBe(1);
		expect(emitter.stats()).toMatchObject({ buffered: 0, unattributed: 2 });
		await emitter.close();
	});

	it("serializes concurrent flushes and closes after a final attempt", async () => {
		const clock = new Clock();
		let active = 0;
		let maximum = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const emitter = createUsageEmitter(
			options(clock, async () => {
				active++;
				maximum = Math.max(maximum, active);
				await gate;
				active--;
			}),
		);
		emitter.onUsage(event());
		const first = emitter.flush();
		const second = emitter.flush();
		release?.();
		await Promise.all([first, second]);
		expect(maximum).toBe(1);
		emitter.onUsage(event());
		await emitter.close();
		expect(emitter.stats()).toMatchObject({ buffered: 0, sent: 2 });
		expect(clock.timers.size).toBe(0);
	});
	it("uses a UUID id when no id factory is supplied", async () => {
		const clock = new Clock();
		let sent: TokenUsageEvent[] = [];
		const emitter = createUsageEmitter(
			options(
				clock,
				async batch => {
					sent = batch;
				},
				{ newId: undefined },
			),
		);
		emitter.onUsage(event());
		await emitter.flush();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		await emitter.close();
	});

	it("preserves in-flight chunk rows when capacity overflows", async () => {
		const clock = new Clock();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const batches: string[][] = [];
		const emitter = createUsageEmitter(
			options(
				clock,
				async batch => {
					batches.push(batch.map(row => row.id));
					if (batches.length === 1) {
						started.resolve();
						await release.promise;
					}
				},
				{ maxEvents: 3, maxBatch: 2 },
			),
		);
		for (let index = 0; index < 3; index++) emitter.onUsage(event());
		const flush = emitter.flush();
		await started.promise;
		for (let index = 0; index < 3; index++) emitter.onUsage(event());
		release.resolve();
		await flush;
		expect(batches).toEqual([["id-1", "id-2"], ["id-4", "id-5"], ["id-6"]]);
		expect(emitter.stats()).toMatchObject({ buffered: 0, dropped: 1, sent: 5 });
		await emitter.close();
	});

	it("retries an in-flight chunk before buffered rows after overflow", async () => {
		const clock = new Clock();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const batches: string[][] = [];
		let failFirst = true;
		const emitter = createUsageEmitter(
			options(
				clock,
				async batch => {
					batches.push(batch.map(row => row.id));
					if (failFirst) {
						failFirst = false;
						started.resolve();
						await release.promise;
						throw new Error("offline");
					}
				},
				{ maxEvents: 3, maxBatch: 2 },
			),
		);
		for (let index = 0; index < 3; index++) emitter.onUsage(event());
		const flush = emitter.flush();
		await started.promise;
		for (let index = 0; index < 3; index++) emitter.onUsage(event());
		release.resolve();
		await flush;
		expect(emitter.stats()).toMatchObject({ buffered: 3, dropped: 3 });
		clock.fireNext();
		await emitter.flush();
		expect(batches.slice(1)).toEqual([["id-1", "id-2"], ["id-6"]]);
		expect(emitter.stats()).toMatchObject({ buffered: 0, sent: 3, dropped: 3 });
		await emitter.close();
	});

	it("shares close completion and drops usage received after close starts", async () => {
		const clock = new Clock();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const emitter = createUsageEmitter(
			options(clock, async () => {
				started.resolve();
				await release.promise;
			}),
		);
		emitter.onUsage(event());
		const first = emitter.close();
		await started.promise;
		let secondResolved = false;
		const second = emitter.close().then(() => {
			secondResolved = true;
		});
		emitter.onUsage(event());
		expect(emitter.stats()).toMatchObject({ buffered: 0, dropped: 1 });
		await Promise.resolve();
		expect(secondResolved).toBe(false);
		release.resolve();
		await Promise.all([first, second]);
		expect(secondResolved).toBe(true);
		expect(emitter.stats()).toMatchObject({ buffered: 0, sent: 1, dropped: 1 });
	});

	it("rejects empty attribution keys", async () => {
		for (const keys of [
			{ agentAccountId: "", ownerUserId: "owner" },
			{ agentAccountId: "agent", ownerUserId: "" },
		]) {
			const emitter = createUsageEmitter(options(new Clock(), async () => {}, { attribute: () => keys }));
			emitter.onUsage(event());
			expect(emitter.stats()).toMatchObject({ buffered: 0, unattributed: 1 });
			await emitter.close();
		}
	});

	it("drops a chained flush's failed chunk before close resolves", async () => {
		const clock = new Clock();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const emitter = createUsageEmitter(
			options(
				clock,
				async () => {
					calls++;
					if (calls === 1) {
						started.resolve();
						await release.promise;
						return;
					}
					throw new Error("offline");
				},
				{ maxBatch: 1 },
			),
		);
		emitter.onUsage(event());
		const drain = emitter.flush();
		await started.promise;
		emitter.onUsage(event());
		const chained = drain.then(() => emitter.flush());
		const closed = emitter.close();
		release.resolve();
		await Promise.all([chained, closed]);
		expect(emitter.stats()).toMatchObject({ buffered: 0, sent: 1, dropped: 1 });
	});

	it("ages the buffer on the monotonic clock, not wall time", async () => {
		const wall = spyOn(Date, "now").mockReturnValue(0);
		const mono = spyOn(performance, "now").mockReturnValue(0);
		try {
			const batches: TokenUsageEvent[][] = [];
			const emitter = createUsageEmitter({
				send: async batch => {
					batches.push(batch);
				},
				attribute: () => attribution,
				rateVersion: "r",
				maxAgeMs: 1_000,
			});
			emitter.onUsage(event());
			wall.mockReturnValue(10_000);
			await emitter.flush();
			expect(batches).toHaveLength(1);
			await emitter.close();
		} finally {
			wall.mockRestore();
			mono.mockRestore();
		}
	});
});
