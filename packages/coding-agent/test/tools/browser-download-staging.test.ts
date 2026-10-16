import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonOperation, DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import * as browserAttach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as browserLaunch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	type BrowserHandle,
	browserKey,
	downloadStagingDirectory,
	type PuppeteerBrowserHandle,
	type PuppeteerBrowserKind,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	DOWNLOAD_STAGING_DIRNAME,
	ensureSharedBrowser,
	sharedBrowserDaemonName,
	sharedBrowserProfileDir,
} from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import {
	buildInitPayloadForTest,
	buildRecyclePayloadForTest,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { Browser } from "puppeteer-core";

const TARGET_ID = "TARGET-1";

/** A browser with one adoptable page, reached at `wsEndpoint`. */
function fakeBrowser(wsEndpoint: string): Browser {
	const page = { url: () => "https://example.com/", title: async () => "Example" };
	const target = { _targetId: TARGET_ID, type: () => "page", page: async () => page };
	Object.assign(page, { target: () => target });
	return { wsEndpoint: () => wsEndpoint, targets: () => [target] } as unknown as Browser;
}

function handle(
	kind: PuppeteerBrowserKind,
	wsEndpoint: string,
	extra: Partial<PuppeteerBrowserHandle> = {},
): PuppeteerBrowserHandle {
	return {
		key: browserKey(kind),
		kind,
		browser: fakeBrowser(wsEndpoint),
		refCount: 0,
		stealth: { browserSession: null, override: null },
		...extra,
	};
}

function endpoint(guid = crypto.randomUUID()): string {
	return `ws://127.0.0.1:9222/devtools/browser/${guid}`;
}

const spawned = (args: string[]): PuppeteerBrowserKind => ({ kind: "spawned", path: "/opt/app/app", args });
const connected: PuppeteerBrowserKind = { kind: "connected", cdpUrl: "http://127.0.0.1:9222" };
const relay: PuppeteerBrowserKind = { kind: "relay", cdpUrl: "http://127.0.0.1:9223" };
const tempDirs: string[] = [];

afterAll(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("downloadStagingDirectory", () => {
	it("gives two handles of one Chrome the same path even when their keys differ", () => {
		const ws = endpoint();
		const first = handle(spawned(["--a"]), ws);
		const second = handle(spawned(["--b"]), ws);
		expect(first.key).not.toBe(second.key);
		const staging = downloadStagingDirectory(first);
		expect(staging).toBeDefined();
		expect(downloadStagingDirectory(second)).toBe(staging);
		expect(downloadStagingDirectory(handle(spawned(["--a"]), endpoint()))).not.toBe(staging);
	});

	it("keys a process-local launch with the caller's own profile by its browser", () => {
		const guid = crypto.randomUUID();
		const headless = handle({ kind: "headless", headless: true }, endpoint(guid));
		expect(path.basename(downloadStagingDirectory(headless) ?? "")).toBe(guid);
	});

	it("is unset for a browser the user drives", () => {
		expect(downloadStagingDirectory(handle(connected, endpoint()))).toBeUndefined();
		expect(downloadStagingDirectory(handle(relay, endpoint()))).toBeUndefined();
	});

	it("gives a browser whose endpoint names no target id one stable path", async () => {
		const ws = "ws://127.0.0.1:9222/devtools/browser/not-a-uuid";
		const staging = downloadStagingDirectory(handle(spawned(["--a"]), ws));
		expect(staging).toBeDefined();
		expect(downloadStagingDirectory(handle(spawned(["--b"]), ws))).toBe(staging);
		expect(downloadStagingDirectory(handle(spawned(["--a"]), "ws://127.0.0.1:9333/x"))).not.toBe(staging);
		const payload = await buildInitPayloadForTest(handle(spawned([]), ws), { timeoutMs: 1_000 });
		expect(payload.downloadStagingDirectory).toBe(staging);
	});

	it("keys a shared daemon's staging by its browser", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-staging-project-"));
		tempDirs.push(projectDir);
		const guid = crypto.randomUUID();
		const shared = handle({ kind: "headless", headless: true }, endpoint(guid), {
			sharedDaemon: { name: "omp.browser.headless", projectDir },
		});
		const staging = downloadStagingDirectory(shared);
		expect(staging).toBe(
			path.join(sharedBrowserProfileDir(projectDir, "omp.browser.headless"), DOWNLOAD_STAGING_DIRNAME, guid),
		);
	});

	it("removes a disconnected process-local browser's staging folder on dispose", async () => {
		const ws = endpoint();
		const local = handle({ kind: "headless", headless: true }, ws);
		Object.assign(local.browser, { connected: false });
		const staging = downloadStagingDirectory(local);
		if (!staging) throw new Error("process-local browser has no staging folder");
		await Bun.write(path.join(staging, "leftover"), "bytes");

		await releaseBrowser(local as BrowserHandle, { kill: true });

		expect(await Bun.file(path.join(staging, "leftover")).exists()).toBe(false);
	});
});

describe("shared daemon staging sweep", () => {
	/** Run `ensureSharedBrowser` against a fake broker that either already runs Chrome at `ws` or starts it there. */
	async function ensureWith(projectDir: string, ws: string, running: boolean) {
		const name = sharedBrowserDaemonName(true);
		const now = Date.now();
		const daemon: DaemonSnapshot = {
			name,
			id: "staging",
			state: "ready",
			createdAt: now,
			startedAt: now,
			readyAt: now,
			readyMatch: `DevTools listening on ${ws}`,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		let starts = 0;
		const client = {
			projectDir,
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				if (operation.op === "describe") {
					if (!running) throw new Error(`Unknown daemon ${operation.name}`);
					return { op: "describe", daemon } as DaemonRpcResult;
				}
				if (operation.op === "start") {
					starts++;
					return { op: "start", daemon, readyTimedOut: false };
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spies = [
			spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client),
			spyOn(browserLaunch, "resolveSharedBrowserLaunchSpec").mockResolvedValue({
				executablePath: "/fake/chrome",
				args: [],
			}),
			spyOn(browserAttach, "probeCdpStatus").mockResolvedValue(200),
			spyOn(browserLaunch, "seedOwnedProfilePreferences").mockResolvedValue(undefined),
		];
		try {
			const shared = await ensureSharedBrowser({ projectDir, headless: true });
			return {
				shared,
				starts,
				parent: path.join(sharedBrowserProfileDir(projectDir, name), DOWNLOAD_STAGING_DIRNAME),
			};
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	}

	async function seedStaging(projectDir: string, ids: string[]): Promise<void> {
		const parent = path.join(
			sharedBrowserProfileDir(projectDir, sharedBrowserDaemonName(true)),
			DOWNLOAD_STAGING_DIRNAME,
		);
		for (const id of ids) await Bun.write(path.join(parent, id, "leftover"), "bytes");
	}

	it("sweeps dead siblings and keeps the fresh Chrome's folder after starting it", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-staging-project-"));
		tempDirs.push(projectDir);
		const fresh = crypto.randomUUID();
		const dead = crypto.randomUUID();
		await seedStaging(projectDir, [fresh, dead]);

		const { shared, starts, parent } = await ensureWith(projectDir, endpoint(fresh), false);

		expect(shared?.wsEndpoint).toBe(endpoint(fresh));
		expect(starts).toBe(1);
		expect(await fs.readdir(parent)).toEqual([fresh]);
	});

	it("sweeps nothing when adopting a running Chrome", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-staging-project-"));
		tempDirs.push(projectDir);
		const live = crypto.randomUUID();
		const other = crypto.randomUUID();
		await seedStaging(projectDir, [live, other]);

		const { shared, starts, parent } = await ensureWith(projectDir, endpoint(live), true);

		expect(shared?.wsEndpoint).toBe(endpoint(live));
		expect(starts).toBe(0);
		expect((await fs.readdir(parent)).sort()).toEqual([live, other].sort());
	});
});

describe("worker init payload staging folder", () => {
	it("is set for a new headless tab", async () => {
		const browser = handle({ kind: "headless", headless: true }, endpoint(), { userDataDir: "/tmp/omp-profile" });
		const payload = await buildInitPayloadForTest(browser, { timeoutMs: 1_000 });
		expect(payload.mode).toBe("headless");
		expect(payload.downloadStagingDirectory).toBe(downloadStagingDirectory(browser));
		expect(payload.downloadStagingDirectory).toBeDefined();
	});

	it("is set for a new tab attached to a spawned app OMP launched", async () => {
		const browser = handle(spawned([]), endpoint());
		const payload = await buildInitPayloadForTest(browser, { timeoutMs: 1_000 });
		expect(payload.mode).toBe("attach");
		expect(payload.downloadStagingDirectory).toBe(downloadStagingDirectory(browser));
		expect(payload.downloadStagingDirectory).toBeDefined();
	});

	it("is unset for a new tab attached to a connected browser", async () => {
		const payload = await buildInitPayloadForTest(handle(connected, endpoint()), { timeoutMs: 1_000 });
		expect(payload.mode).toBe("attach");
		expect(payload.downloadStagingDirectory).toBeUndefined();
	});

	it("is set when a timed-out tab's worker is recycled, and unset for a connected browser", () => {
		const recycled = (browser: PuppeteerBrowserHandle) =>
			buildRecyclePayloadForTest({
				browser,
				targetId: TARGET_ID,
				kindTag: browser.kind.kind,
				activateForScreenshot: true,
			} as unknown as WorkerTabSession);
		const headless = handle({ kind: "headless", headless: true }, endpoint(), {
			sharedDaemon: { name: "omp.browser.headless", projectDir: "/tmp/omp-project" },
		});
		expect(recycled(headless).downloadStagingDirectory).toBe(downloadStagingDirectory(headless));
		expect(recycled(headless).downloadStagingDirectory).toBeDefined();
		const app = handle(spawned([]), endpoint());
		expect(recycled(app).downloadStagingDirectory).toBe(downloadStagingDirectory(app));
		expect(recycled(handle(connected, endpoint())).downloadStagingDirectory).toBeUndefined();
	});
});
