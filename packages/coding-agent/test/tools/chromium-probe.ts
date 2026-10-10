import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

const PROBE_TIMEOUT_MS = 10_000;

/** Linux checks for a live headless browser; the outer bound includes resolve. */
export async function chromiumCanLaunch(
	resolveExecutable: () => Promise<string | undefined> = ensureChromiumExecutable,
	timeoutMs = PROBE_TIMEOUT_MS,
	checkAvailability: (
		executable: string,
		timeoutMs: number,
		signal: AbortSignal,
	) => Promise<boolean> = chromiumCdpAvailable,
): Promise<boolean> {
	const startedAt = performance.now();
	const controller = new AbortController();
	const { promise: deadline, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => {
		controller.abort();
		console.error(
			`chromium-probe: no answer within ${timeoutMs}ms; treating Chromium as unavailable and SKIPPING the browser suites`,
		);
		resolve(false);
	}, timeoutMs);
	try {
		return await Promise.race([
			(async () => {
				const executable = await resolveExecutable();
				if (!executable) return false;
				const remainingMs = timeoutMs - (performance.now() - startedAt);
				if (remainingMs <= 100) return false;
				// Avoid GUI binaries that may never exit without a display (#8445).
				if (process.platform !== "linux") return (await fs.stat(executable)).isFile();
				return await checkAvailability(executable, remainingMs - 100, controller.signal);
			})(),
			deadline,
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** A disposable headless launch must answer CDP. */
export async function chromiumCdpAvailable(
	executable: string,
	timeoutMs = 5000,
	signal?: AbortSignal,
): Promise<boolean> {
	const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-chromium-probe-"));
	let child: ChildProcess | undefined;
	try {
		const port = await findFreeCdpPort();
		child = ptree.spawn(
			[
				executable,
				"--headless=new",
				"--no-sandbox",
				"--no-first-run",
				"--no-default-browser-check",
				`--user-data-dir=${userDataDir}`,
				`--remote-debugging-port=${port}`,
				"about:blank",
			],
			{ stdin: "ignore", detached: true, subreaper: true },
		);
		await waitForCdp(`http://127.0.0.1:${port}`, timeoutMs, signal);
		return true;
	} catch {
		return false;
	} finally {
		if (child) {
			child.kill(undefined, -1);
			await child.wait({ allowAbort: true, allowNonZero: true });
		}
		await fs.rm(userDataDir, { recursive: true, force: true });
	}
}

let probe: Promise<boolean> | undefined;

// Return a promise to avoid a top-level-await export TDZ in concurrent importers.
export function chromiumAvailable(): Promise<boolean> {
	probe ??= chromiumCanLaunch();
	return probe;
}

let visibleProbe: Promise<boolean> | undefined;

// Headful launches need a display on Linux.
export function visibleBrowserAvailable(): Promise<boolean> {
	visibleProbe ??= (async () => {
		if (!(await chromiumAvailable())) return false;
		if (process.platform !== "linux") return true;
		return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	})();
	return visibleProbe;
}
