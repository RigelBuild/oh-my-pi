import { expect, test } from "bun:test";
import { chromiumCanLaunch } from "./chromium-probe";

const BOUND_MS = 2_000;

const EXECUTABLE = "/nonexistent/chromium";
const never = () => Promise.withResolvers<boolean>().promise;

test("reports a launchable binary as available", async () => {
	expect(await chromiumCanLaunch(async () => EXECUTABLE, async () => true, BOUND_MS)).toBe(true);
}, 30_000);

test("stays silent when the probe succeeds", async () => {
	// The subject's deadline is an `AbortSignal.timeout`, which fake timers do
	// not drive — the abort fires off the platform clock. Use a tiny real bound
	// and outlive it, so a late `abort` listener would have fired by now.
	const tinyBoundMs = 25;
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	try {
		expect(await chromiumCanLaunch(async () => EXECUTABLE, async () => true, tinyBoundMs)).toBe(true);
		await Bun.sleep(tinyBoundMs * 4);
	} finally {
		console.error = original;
	}
	expect(errors.filter(line => line.includes("SKIPPING"))).toEqual([]);
}, 30_000);

test("reports a binary that never answers CDP as unavailable", async () => {
	expect(await chromiumCanLaunch(async () => EXECUTABLE, async () => false, BOUND_MS)).toBe(false);
}, 30_000);

test("reports an unresolvable executable as unavailable", async () => {
	expect(await chromiumCanLaunch(async () => undefined, async () => true, BOUND_MS)).toBe(false);
}, 30_000);

test("reports a failed resolve as unavailable", async () => {
	expect(
		await chromiumCanLaunch(
			() => Promise.reject(new Error("resolve exploded")),
			async () => true,
			BOUND_MS,
		),
	).toBe(false);
}, 30_000);

test("bounds a launch that never settles", async () => {
	expect(await chromiumCanLaunch(async () => EXECUTABLE, never, BOUND_MS)).toBe(false);
}, 30_000);

test("bounds a slow resolve, not just the launch", async () => {
	// A resolve that never settles stands in for the unbounded first-use
	// Chromium download `ensureChromiumExecutable()` can perform.
	const available = await chromiumCanLaunch(
		() => Promise.withResolvers<string | undefined>().promise,
		async () => true,
		BOUND_MS,
	);
	expect(available).toBe(false);
}, 30_000);

test("announces the skip when nothing answers within the bound", async () => {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	let available: boolean;
	try {
		available = await chromiumCanLaunch(() => Promise.withResolvers<string | undefined>().promise, undefined, BOUND_MS);
	} finally {
		console.error = original;
	}
	expect(available).toBe(false);
	expect(errors.filter(line => /no answer within 2000ms.*SKIPPING/.test(line))).toHaveLength(1);
}, 30_000);
