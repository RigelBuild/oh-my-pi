import type { Subprocess } from "bun";
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromiumCanLaunch } from "./chromium-probe";

// `chromiumCanLaunch` gates every browser E2E in this package. A wrong `false`
// silently SKIPS all of them and the required CI gate goes green having tested
// nothing, so the bound and its verdicts are worth pinning directly.
//
// The deadline must cover the RESOLVE too, not just the `--version` spawn: on
// CI nothing sets PUPPETEER_EXECUTABLE_PATH, so resolution walks PATH
// candidates and spawns `--version` per candidate. Bounding only the final
// spawn leaves that prefix ungoverned during module evaluation, which no test
// bound and not the harness `--timeout` can cut.
//
// Every test injects the bound rather than exercising the real 10s default:
// these assert that a deadline fires and is honoured, which a short one shows
// just as well while keeping the suite off the wall clock. Injecting it in the
// PASSING tests too matters for the same reason this file exists — left on the
// 10s default they would carry an inner bound above a bare `bun test`'s 5s
// harness default, which is a coincident pair of exactly the shape this PR
// removes. 2s is well clear of spawning a bash script (~5ms here) while far
// under the blocking fixtures, so a regression that drops the deadline fails
// them on the bound rather than racing it.
const BOUND_MS = 2_000;
const BLOCK_S = 30;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromium-probe-test-"));

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
	const file = path.join(dir, name);
	await fs.writeFile(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
	return file;
}

test("reports a working binary as available", async () => {
	const ok = await script("ok.sh", 'echo "Chromium 150.0.0.0"');
	expect(await chromiumCanLaunch(async () => ok, BOUND_MS)).toBe(true);
});

test("stays silent when the probe succeeds", async () => {
	// The deadline's abort listener runs even after a fast success, because
	// `AbortSignal.timeout` cannot be cancelled. Unguarded it announced a skip on
	// every healthy run — six per suite — which is worse than saying nothing: a
	// real skip becomes indistinguishable from the noise. Nothing else here
	// asserts the stderr contract, which is why that regression shipped.
	const ok = await script("ok-silent.sh", 'echo "Chromium 150.0.0.0"');
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	try {
		expect(await chromiumCanLaunch(async () => ok, BOUND_MS)).toBe(true);
		// Outlive the deadline: the listener fires at BOUND_MS, after the verdict.
		const idle = Bun.spawn(["sleep", String((BOUND_MS * 2) / 1000)]);
		await idle.exited;
	} finally {
		console.error = original;
	}
	expect(errors.filter(line => line.includes("SKIPPING"))).toEqual([]);
});

test("reports a non-zero exit as unavailable", async () => {
	const bad = await script("bad.sh", "exit 127");
	expect(await chromiumCanLaunch(async () => bad, BOUND_MS)).toBe(false);
});

test("reports an unresolvable executable as unavailable", async () => {
	expect(await chromiumCanLaunch(async () => undefined, BOUND_MS)).toBe(false);
});

test.skipIf(process.platform !== "linux")("bounds a binary that never answers --version", async () => {
	const hang = await script("hang.sh", `sleep ${BLOCK_S}`);
	expect(await chromiumCanLaunch(async () => hang, BOUND_MS)).toBe(false);
});

test.skipIf(process.platform !== "linux")("bounds a binary that ignores SIGTERM", async () => {
	// The default kill signal would leave `exited` pending here, degrading the
	// bound to no bound; the probe uses SIGKILL for exactly this shape.
	const stubborn = await script("stubborn.sh", `trap "" TERM\nsleep ${BLOCK_S}`);
	expect(await chromiumCanLaunch(async () => stubborn, BOUND_MS)).toBe(false);
});

test.skipIf(process.platform !== "linux")("bounds a slow resolve, not just the version spawn", async () => {
	// The CI-shaped hazard: resolution itself is slow (it probes candidates), and
	// the executable it eventually returns is fine. A bound armed only around the
	// spawn would let this run for the full resolve.
	//
	// The blocker is the test's own child, not the probe's, so the probe's
	// `signal:`/`killSignal` cannot reap it. Left alive it keeps this process up
	// for its full sleep — a green, fast-looking test that stalls the chunk by
	// BLOCK_S. This bucket runs `parallel: 1`, so that is added wall clock in the
	// very job this file exists to keep green. Kill it explicitly.
	const ok = await script("ok-after-slow-resolve.sh", 'echo "Chromium 150.0.0.0"');
	let blocker: Subprocess | undefined;
	try {
		const available = await chromiumCanLaunch(async () => {
			const { promise, resolve } = Promise.withResolvers<string>();
			blocker = Bun.spawn(["sleep", String(BLOCK_S)]);
			void blocker.exited.then(() => resolve(ok));
			return promise;
		}, BOUND_MS);
		expect(available).toBe(false);
	} finally {
		blocker?.kill();
	}
});
