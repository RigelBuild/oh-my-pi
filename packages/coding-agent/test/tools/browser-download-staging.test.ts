import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
	browserKey,
	downloadStagingDirectory,
	type PuppeteerBrowserHandle,
	type PuppeteerBrowserKind,
	sweepDeadSharedStaging,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
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

	it("keys a shared daemon's staging by its browser and sweeps the folders of dead ones", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-staging-project-"));
		tempDirs.push(projectDir);
		const guid = crypto.randomUUID();
		const shared = handle({ kind: "headless", headless: true }, endpoint(guid), {
			sharedDaemon: { name: "omp.browser.headless", projectDir },
		});
		const staging = downloadStagingDirectory(shared);
		if (!staging) throw new Error("shared daemon has no staging folder");
		expect(path.basename(staging)).toBe(guid);
		const dead = path.join(path.dirname(staging), crypto.randomUUID());
		await Bun.write(path.join(dead, "leftover"), "bytes");
		await Bun.write(path.join(staging, "live"), "bytes");

		await sweepDeadSharedStaging(staging);

		expect(await fs.readdir(path.dirname(staging))).toEqual([guid]);
		expect(await Bun.file(path.join(staging, "live")).text()).toBe("bytes");
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
