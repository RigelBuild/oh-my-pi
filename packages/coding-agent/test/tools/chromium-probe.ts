import * as fs from "node:fs/promises";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// A working `chromium --version` answers in well under a second, and a resolve
// that has to walk PATH candidates costs a few seconds at worst. This only has
// to be clear of a loaded runner, not of a slow launch.
const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether the Chromium puppeteer resolves can actually execute on this host.
 * CI runners without Chrome's system libraries (libnspr4 & co.) hold the
 * downloaded binary but cannot exec it — probe with --version and skip
 * instead of failing.
 *
 * `resolve` and `timeoutMs` are injectable so the bound can be tested against a
 * fixture binary and a short deadline, without a real Chromium or a real wait.
 */
export async function chromiumCanLaunch(
	resolve: () => Promise<string | undefined> = ensureChromiumExecutable,
	timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	// The deadline covers the WHOLE body, resolve included, because this runs
	// during MODULE EVALUATION of every importing suite (`await
	// chromiumAvailable()` at module scope) — a phase no `it()`/hook bound can
	// wrap and the harness `--timeout` does not govern (measured: a module scope
	// that blocks for 25s finishes in 25s under `--timeout=2000`). Bounding only
	// the `--version` spawn would leave the resolve ahead of it ungoverned, and
	// that resolve spawns `--version` once per PATH candidate itself
	// (`isChromiumExecutable`, src/tools/browser/launch.ts) — measured at 21.6s
	// across five slow candidates, which is the configuration CI actually takes
	// since it sets no `PUPPETEER_EXECUTABLE_PATH`. Treat unanswered as unusable,
	// which is this function's existing contract for a binary that cannot exec:
	// a Chromium too slow to answer should SKIP the suites, never hang the run.
	//
	// But a timeout is NOT the same evidence as "cannot exec", and
	// `chromiumAvailable()` memoizes this verdict for the process — so a resolve
	// that transiently overruns pins every browser E2E to skipped. A silent skip
	// is the one outcome worse than a failure here, because the required gate
	// goes green having tested nothing. Say so on stderr so it is visible in the
	// CI log rather than inferred from a suspiciously fast green.
	// `AbortSignal.timeout` cannot be cancelled, so the abort listener still runs
	// after a fast, successful probe — hence the `settled` guard. Without it the
	// diagnostic fires on every healthy run and claims the suites were skipped
	// when they ran, which destroys the signal it exists to give.
	const deadline = AbortSignal.timeout(timeoutMs);
	let settled = false;
	try {
		return await Promise.race([
			probeExecutable(resolve, deadline).then(verdict => {
				settled = true;
				return verdict;
			}),
			new Promise<boolean>(resolveRace => {
				deadline.addEventListener(
					"abort",
					() => {
						if (settled) return;
						console.error(
							`chromium-probe: no answer within ${timeoutMs}ms; treating Chromium as unavailable and SKIPPING the browser suites`,
						);
						resolveRace(false);
					},
					{ once: true },
				);
			}),
		]);
	} catch {
		settled = true;
		return false;
	}
}

async function probeExecutable(resolve: () => Promise<string | undefined>, deadline: AbortSignal): Promise<boolean> {
	const executable = await resolve();
	if (!executable) return false;
	// Only Linux runs the exec probe. Elsewhere the resolved candidate is a
	// GUI application path, and running it is the hazard
	// `isChromiumExecutable()` already refuses for the same reason (#8445): a
	// GUI `chrome.exe --version` prints nothing to a detached stdout and does
	// not exit, so the probe below would never answer and every importing suite
	// hangs during module evaluation. Check the file instead, so a stale
	// PUPPETEER_EXECUTABLE_PATH — which `ensureChromiumExecutable()` hands
	// back unvalidated — still skips the suites rather than failing them at
	// launch.
	if (process.platform !== "linux") return (await fs.stat(executable)).isFile();
	// SIGKILL and `signal:`, matching `isChromiumExecutable`'s convention: the
	// resolved binary is often a wrapper script, and a child that ignores
	// SIGTERM would leave `exited` pending — turning the bound back into none.
	const probe = Bun.spawn([executable, "--version"], {
		stdout: "ignore",
		stderr: "ignore",
		signal: deadline,
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
