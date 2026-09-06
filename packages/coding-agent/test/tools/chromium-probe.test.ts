import { expect, test } from "bun:test";
import { chromiumCanLaunch } from "./chromium-probe";

const BOUND_MS = 200;
const BLOCK_MS = 1_000;

test("reports a successful availability check", async () => {
	expect(
		await chromiumCanLaunch(
			async () => "chromium",
			BOUND_MS,
			async () => true,
		),
	).toBe(true);
});

test("returns unavailable when resolution finds no executable", async () => {
	expect(await chromiumCanLaunch(async () => undefined, BOUND_MS)).toBe(false);
});

test("outer deadline covers slow resolution", async () => {
	const startedAt = performance.now();
	const { promise, resolve } = Promise.withResolvers<string>();
	setTimeout(() => resolve("chromium"), BLOCK_MS);
	const available = await chromiumCanLaunch(
		async () => promise,
		BOUND_MS,
		async () => true,
	);
	expect(available).toBe(false);
	expect(performance.now() - startedAt).toBeLessThan(BLOCK_MS);
}, 30_000);

test("outer deadline aborts the CDP check", async () => {
	const startedAt = performance.now();
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let aborted = false;
	const available = await chromiumCanLaunch(
		async () => "chromium",
		BOUND_MS,
		(_executable, _timeoutMs, signal) => {
			signal.addEventListener("abort", () => {
				aborted = signal.aborted;
				resolve(false);
			});
			return promise;
		},
	);
	expect(available).toBe(false);
	expect(aborted).toBe(true);
	expect(performance.now() - startedAt).toBeLessThan(BLOCK_MS);
}, 30_000);

test("announces when the outer deadline expires", async () => {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	let available: boolean;
	try {
		const { promise } = Promise.withResolvers<string>();
		available = await chromiumCanLaunch(() => promise, BOUND_MS);
	} finally {
		console.error = original;
	}
	expect(available).toBe(false);
	expect(errors).toHaveLength(1);
}, 30_000);
