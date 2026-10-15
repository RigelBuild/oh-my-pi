import { describe, expect, it } from "bun:test";

import * as fs from "node:fs";
import * as path from "node:path";
import { launchHeadlessBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { TempDir } from "@oh-my-pi/pi-utils";

const FIXTURE = path.resolve(import.meta.dir, "../fixtures/browser-launch-stalled-cdp.ts");
const MAX_LAUNCH_MS = 5_000;

async function waitForPidOrLaunch(pidFile: string, launch: Promise<unknown>): Promise<number> {
	const { promise: pidAppeared, resolve, reject } = Promise.withResolvers<number>();
	const readPid = async (): Promise<void> => {
		try {
			const pid = Number(await fs.promises.readFile(pidFile, "utf8"));
			if (Number.isInteger(pid) && pid > 0) resolve(pid);
			else reject(new Error(`Invalid fixture PID: ${pid}`));
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") reject(error);
		}
	};
	const watcher = fs.watch(path.dirname(pidFile), (_event, filename) => {
		if (filename === path.basename(pidFile)) void readPid();
	});
	watcher.on("error", reject);
	void readPid();
	try {
		return await Promise.race([
			pidAppeared,
			launch.then(
				() => Promise.reject(new Error("Browser launch unexpectedly resolved before the fixture PID appeared")),
				error => Promise.reject(error),
			),
		]);
	} finally {
		watcher.close();
	}
}

async function expectFixtureExited(pidFile: string, withinMs = MAX_LAUNCH_MS): Promise<void> {
	const pid = Number(await fs.promises.readFile(pidFile, "utf8"));
	const deadline = performance.now() + withinMs;
	while (performance.now() < deadline) {
		let stat: string;
		try {
			stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		if (state === "Z" || state === "X") return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Fixture process ${pid} did not exit`);
}

// A failed exit assertion must not leak the fixture past the test.
async function killFixture(pidFile: string): Promise<void> {
	if (!fs.existsSync(pidFile)) return;
	const pid = Number(await fs.promises.readFile(pidFile, "utf8"));
	if (!Number.isInteger(pid) || pid <= 0 || !fs.existsSync(`/proc/${pid}`)) return;
	process.kill(pid, "SIGKILL");
	await expectFixtureExited(pidFile);
}

async function withFakeBrowser(run: (pidFile: string) => Promise<void>, mode = "silent"): Promise<void> {
	const tempDir = TempDir.createSync("@browser-launch-deadline-");
	const executable = path.join(tempDir.path(), "fake-chromium");
	const pidFile = path.join(tempDir.path(), "fixture.pid");
	const previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
	const previousPidFile = process.env.OMP_BROWSER_STALLED_PID_FILE;
	const previousMode = process.env.OMP_BROWSER_STALLED_MODE;
	await Bun.write(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}\n`);
	fs.chmodSync(executable, 0o755);
	process.env.PUPPETEER_EXECUTABLE_PATH = executable;
	process.env.OMP_BROWSER_STALLED_PID_FILE = pidFile;
	process.env.OMP_BROWSER_STALLED_MODE = mode;
	try {
		await run(pidFile);
	} finally {
		if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
		else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
		if (previousPidFile === undefined) delete process.env.OMP_BROWSER_STALLED_PID_FILE;
		else process.env.OMP_BROWSER_STALLED_PID_FILE = previousPidFile;
		if (previousMode === undefined) delete process.env.OMP_BROWSER_STALLED_MODE;
		else process.env.OMP_BROWSER_STALLED_MODE = previousMode;
		await killFixture(pidFile);
		await tempDir.remove();
	}
}

async function expectFastRejection(
	launch: Promise<unknown>,
	check: (error: Error) => void,
	withinMs = MAX_LAUNCH_MS,
): Promise<void> {
	const startedAt = performance.now();
	const result = await Promise.race([
		launch.then(
			() => ({ kind: "resolved" as const }),
			error => ({ kind: "rejected" as const, error }),
		),
		new Promise<{ kind: "slow" }>(resolve => setTimeout(() => resolve({ kind: "slow" }), withinMs)),
	]);
	expect(result.kind).toBe("rejected");
	if (result.kind === "rejected") {
		expect(result.error).toBeInstanceOf(Error);
		if (result.error instanceof Error) {
			check(result.error);
		}
	}
	expect(performance.now() - startedAt).toBeLessThan(withinMs);
}

describe("headless browser launch deadline", () => {
	it.skipIf(process.platform !== "linux")(
		"aborts the CDP handshake and exits Chromium within the caller deadline",
		async () => {
			await withFakeBrowser(async pidFile => {
				const launch = launchHeadlessBrowser({ headless: true, signal: AbortSignal.timeout(1500) });
				void launch.catch(() => undefined);
				await waitForPidOrLaunch(pidFile, launch);
				await expectFastRejection(launch, error => expect(error.name).toBe("AbortError"));
				await expectFixtureExited(pidFile);
			});
		},
		20_000,
	);

	it.skipIf(process.platform !== "linux")(
		"honors an overridden CDP protocol timeout",
		async () => {
			await withFakeBrowser(async pidFile => {
				const launch = launchHeadlessBrowser({ headless: true, protocolTimeoutMs: 1000 });
				void launch.catch(() => undefined);
				await waitForPidOrLaunch(pidFile, launch);
				await expectFastRejection(launch, error => {
					expect(error.message.toLowerCase()).toContain("cdp handshake");
					expect(error.cause).toBeDefined();
				});
				await expectFixtureExited(pidFile);
			});
		},
		20_000,
	);

	it.skipIf(process.platform !== "linux")(
		"force-closes a browser that acknowledges Browser.close but never exits",
		async () => {
			await withFakeBrowser(async pidFile => {
				// Page-target budget plus the 5 s graceful-close bound.
				const withinMs = 1_000 + 5_000 + MAX_LAUNCH_MS;
				const launch = launchHeadlessBrowser({ headless: true, timeoutMs: 1_000 });
				void launch.catch(() => undefined);
				await waitForPidOrLaunch(pidFile, launch);
				await expectFastRejection(
					launch,
					error => expect(error.message.toLowerCase()).toContain("page target"),
					withinMs,
				);
				await expectFixtureExited(pidFile);
			}, "ack");
		},
		30_000,
	);

	it.skipIf(process.platform !== "linux")(
		"force-closes a browser that never answers Browser.close",
		async () => {
			await withFakeBrowser(async pidFile => {
				const withinMs = 1_000 + 5_000 + MAX_LAUNCH_MS;
				const launch = launchHeadlessBrowser({ headless: true, timeoutMs: 1_000 });
				void launch.catch(() => undefined);
				await waitForPidOrLaunch(pidFile, launch);
				await expectFastRejection(
					launch,
					error => expect(error.message.toLowerCase()).toContain("page target"),
					withinMs,
				);
				await expectFixtureExited(pidFile);
			}, "ack-no-close");
		},
		30_000,
	);

	it.skipIf(process.platform !== "linux")(
		"bounds a stalled WebSocket upgrade by timeoutMs without a caller signal",
		async () => {
			await withFakeBrowser(async pidFile => {
				const launch = launchHeadlessBrowser({ headless: true, timeoutMs: 1_500 });
				void launch.catch(() => undefined);
				await waitForPidOrLaunch(pidFile, launch);
				await expectFastRejection(launch, error => {
					expect(error.message.toLowerCase()).toContain("cdp handshake");
				});
				await expectFixtureExited(pidFile);
			}, "no-upgrade");
		},
		45_000,
	);
});
