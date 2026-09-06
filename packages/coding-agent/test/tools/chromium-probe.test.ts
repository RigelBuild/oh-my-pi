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
// The bound is injected rather than exercised at its real 10s: these assert
// that a deadline fires and is honoured, which a short one shows just as well
// while keeping the suite off the wall clock. The blocking fixtures below sleep
// far past the injected bound, so a regression that drops the deadline fails
// them on the bound rather than racing it.
const BOUND_MS = 250;
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
	expect(await chromiumCanLaunch(async () => ok)).toBe(true);
});

test("reports a non-zero exit as unavailable", async () => {
	const bad = await script("bad.sh", "exit 127");
	expect(await chromiumCanLaunch(async () => bad)).toBe(false);
});

test("reports an unresolvable executable as unavailable", async () => {
	expect(await chromiumCanLaunch(async () => undefined)).toBe(false);
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
	const ok = await script("ok-after-slow-resolve.sh", 'echo "Chromium 150.0.0.0"');
	const available = await chromiumCanLaunch(async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		const blocker = Bun.spawn(["sleep", String(BLOCK_S)]);
		void blocker.exited.then(() => resolve(ok));
		return promise;
	}, BOUND_MS);
	expect(available).toBe(false);
});
