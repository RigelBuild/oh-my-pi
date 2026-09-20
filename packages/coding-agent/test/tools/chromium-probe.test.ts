import type { Subprocess } from "bun";
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromiumCanLaunch } from "./chromium-probe";

const BOUND_MS = 2_000;
const BLOCK_S = 10;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromium-probe-test-"));

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
}, 30_000);

async function script(name: string, body: string): Promise<string> {
	const file = path.join(dir, name);
	await fs.writeFile(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
	return file;
}

test("reports a working binary as available", async () => {
	const ok = await script("ok.sh", 'echo "Chromium 150.0.0.0"');
	expect(await chromiumCanLaunch(async () => ok, BOUND_MS)).toBe(true);
}, 30_000);

test("stays silent when the probe succeeds", async () => {
	const ok = await script("ok-silent.sh", 'echo "Chromium 150.0.0.0"');
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	try {
		expect(await chromiumCanLaunch(async () => ok, BOUND_MS)).toBe(true);
		const idle = Bun.spawn(["sleep", String((BOUND_MS + 500) / 1000)]);
		await idle.exited;
	} finally {
		console.error = original;
	}
	expect(errors.filter(line => line.includes("SKIPPING"))).toEqual([]);
}, 30_000);

test("reports a non-zero exit as unavailable", async () => {
	const bad = await script("bad.sh", "exit 127");
	expect(await chromiumCanLaunch(async () => bad, BOUND_MS)).toBe(false);
}, 30_000);

test("reports an unresolvable executable as unavailable", async () => {
	expect(await chromiumCanLaunch(async () => undefined, BOUND_MS)).toBe(false);
}, 30_000);

test.skipIf(process.platform !== "linux")(
	"bounds a binary that never answers --version",
	async () => {
		const hang = await script("hang.sh", `exec sleep ${BLOCK_S}`);
		expect(await chromiumCanLaunch(async () => hang, BOUND_MS)).toBe(false);
	},
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"bounds a binary that ignores SIGTERM",
	async () => {
		const stubborn = await script("stubborn.sh", `trap "" TERM\nexec sleep ${BLOCK_S}`);
		expect(await chromiumCanLaunch(async () => stubborn, BOUND_MS)).toBe(false);
	},
	30_000,
);

test.skipIf(process.platform !== "linux")(
	"bounds a slow resolve, not just the version spawn",
	async () => {
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
	},
	30_000,
);

test("announces the skip when nothing answers within the bound", async () => {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	let available: boolean;
	try {
		available = await chromiumCanLaunch(() => Promise.withResolvers<string | undefined>().promise, BOUND_MS);
	} finally {
		console.error = original;
	}
	expect(available).toBe(false);
	expect(errors.filter(line => /no answer within 2000ms.*SKIPPING/.test(line))).toHaveLength(1);
}, 30_000);
