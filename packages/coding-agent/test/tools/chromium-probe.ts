import * as fs from "node:fs/promises";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Run Chromium resolution and execution under one deadline. */
export async function chromiumCanLaunch(
	resolve: () => Promise<string | undefined> = ensureChromiumExecutable,
	timeoutMs = VERSION_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = AbortSignal.timeout(timeoutMs);
	let settled = false;
	try {
		return await Promise.race([
			probeExecutable(resolve, deadline).then(
				verdict => {
					settled = true;
					return verdict;
				},
				error => {
					settled = true;
					throw error;
				},
			),
			new Promise<boolean>(resolveRace => {
				deadline.addEventListener("abort", () => {
					if (settled) return;
					console.error(
						`chromium-probe: no answer within ${timeoutMs}ms; treating Chromium as unavailable and SKIPPING the browser suites`,
					);
					resolveRace(false);
				});
			}),
		]);
	} catch {
		return false;
	}
}

async function probeExecutable(resolve: () => Promise<string | undefined>, signal: AbortSignal): Promise<boolean> {
	const executable = await resolve();
	if (!executable) return false;
	if (process.platform !== "linux") return (await fs.stat(executable)).isFile();
	const probe = Bun.spawn([executable, "--version"], {
		stdout: "ignore",
		stderr: "ignore",
		signal,
		killSignal: "SIGKILL",
	});
	return (await probe.exited) === 0;
}

let probe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a real Chromium:
 *
 *     const CHROMIUM_AVAILABLE = await chromiumAvailable();
 *     describe.skipIf(!CHROMIUM_AVAILABLE)(…);
 *
 * The result is a promise rather than an awaited `export const`. A module whose
 * exports are initialized by top-level await hands the test runner a binding
 * that is still in its temporal dead zone when a second test file in the same
 * process imports it, and that file dies during registration with "Cannot
 * access 'CHROMIUM_AVAILABLE' before initialization". Awaiting in the importer
 * makes the wait part of that file's own evaluation, which the runner does
 * sequence. The probe runs once per process.
 */
export function chromiumAvailable(): Promise<boolean> {
	probe ??= chromiumCanLaunch();
	return probe;
}

let visibleProbe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a *headful* Chromium (`headless: false`).
 *
 * `chromiumAvailable()` only proves the binary execs: `chrome --version`
 * exits 0 with no display at all, so it cannot gate a headful launch. On a
 * GH-hosted ubuntu runner there is no X server and no xvfb in the workflow,
 * so `puppeteer.launch({ headless: false })` throws "Missing X server or
 * $DISPLAY" and the suite fails rather than skipping. Require a display on
 * Linux; macOS and Windows launch headful without one.
 *
 * Same promise-not-awaited-const shape as `chromiumAvailable()`, for the same
 * temporal-dead-zone reason.
 */
export function visibleBrowserAvailable(): Promise<boolean> {
	visibleProbe ??= (async () => {
		if (!(await chromiumAvailable())) return false;
		if (process.platform !== "linux") return true;
		return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	})();
	return visibleProbe;
}
