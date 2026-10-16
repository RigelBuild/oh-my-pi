import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasFsCode, isEnoent, toError, untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { replaceFileAcrossDevices, replaceFileAtomically } from "../../utils/atomic-file";
import { devtoolsFrameId } from "./frames";

/** Completed download metadata returned by tab download helpers. */
export interface BrowserDownload {
	path: string;
	suggestedFilename: string;
	url: string;
	bytes: number;
}

interface DownloadStarted {
	guid: string;
	url: string;
	suggestedFilename: string;
}

interface DownloadProgress {
	guid: string;
	state: "inProgress" | "completed" | "canceled";
	receivedBytes: number;
	/** Saved location on completion, in whichever folder Chromium was pointed at last. */
	filePath?: string;
}

interface PendingDownload extends DownloadStarted {
	receivedBytes: number;
}

interface DownloadWaiter {
	resolve(value: BrowserDownload): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

type DownloadOutcome = { download: BrowserDownload } | { error: ToolError };

/** Chromium names an `allowAndName` download after its GUID, a lowercase UUID. */
const DOWNLOAD_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per tab, files are saved under their download GUID in `stagingDirectory`, the one folder every tab of the browser
 * shares, and each tab moves its own into its folder. A browser the user drives keeps its folder and real names.
 */
export type DownloadManagerOptions = { perTab: false } | { perTab: true; stagingDirectory: string };

/** Owns tab-scoped Chromium download behavior and completion events. */
export class DownloadManager {
	readonly #browser: Browser;
	readonly #page: Page;
	readonly #defaultDirectory: string;
	readonly #stagingDirectory?: string;
	#directory?: string;
	#arming?: Promise<void>;
	#session?: CDPSession;
	readonly #pending = new Map<string, PendingDownload>();
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: DownloadOutcome[] = [];
	readonly #waiters: DownloadWaiter[] = [];
	#willBegin?: (event: DownloadStarted & { frameId: string }) => void;
	#progress?: (event: DownloadProgress) => void;

	/**
	 * `perTab` gives each tab its own folder by moving each tab's own files out of the browser's staging folder. Leave it
	 * off for a browser the user drives (connected, relay): there the folder also receives the user's own downloads,
	 * which would otherwise be saved under bare GUIDs nobody renames.
	 */
	constructor(browser: Browser, page: Page, tabId: string, options: DownloadManagerOptions) {
		this.#browser = browser;
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
		if (options.perTab) this.#stagingDirectory = options.stagingDirectory;
	}

	/**
	 * Chromium keeps one download path per browser context and fixes each download's target when it starts, so every
	 * tab sends the same staging path; a per-tab path would send one tab's downloads into another's folder.
	 */
	async enable(directory?: string): Promise<void> {
		const resolved = path.resolve(directory ?? this.#defaultDirectory);
		await fs.mkdir(resolved, { recursive: true });
		if (this.#stagingDirectory) await ensurePrivateDirectory(this.#stagingDirectory);
		if (!this.#session) await this.#attach();
		const context = this.#page.browserContext() as { id?: string };
		await this.#session!.send("Browser.setDownloadBehavior", {
			behavior: this.#stagingDirectory ? "allowAndName" : "allow",
			downloadPath: this.#stagingDirectory ?? resolved,
			eventsEnabled: true,
			...(context.id ? { browserContextId: context.id } : {}),
		});
		this.#directory = resolved;
	}

	/** Enabling started by a `wait()` that has not yet applied; settles once downloads are tracked. */
	get arming(): Promise<void> | undefined {
		return this.#arming;
	}

	/** Wait for the next unclaimed completed download. */
	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		if (this.#unclaimed.length === 0) {
			// A rejected `arming` nobody awaits would surface as an unhandled rejection.
			if (signal?.aborted) throw signal.reason;
			// The tab that pointed Chromium last resets it to the browser's default folder when it closes, so re-point it.
			const arming = (this.#arming ??= this.enable(this.#directory).finally(() => {
				this.#arming = undefined;
			}));
			try {
				await untilAborted(signal, arming);
			} catch (error) {
				// Abort with the caller's reason, as the waits below do.
				if (signal?.aborted) throw signal.reason;
				throw error;
			}
		}
		const ready = this.#unclaimed.shift();
		if (ready) {
			if ("error" in ready) throw ready.error;
			return { ...ready.download };
		}
		if (signal?.aborted) throw signal.reason;
		return await new Promise<BrowserDownload>((resolve, reject) => {
			const waiter: DownloadWaiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					this.#removeWaiter(waiter);
					reject(signal.reason);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	/** Return every completed download for this tab. */
	list(): BrowserDownload[] {
		return this.#completed.map(download => ({ ...download }));
	}

	/** Detach event listeners and reject outstanding waits. */
	async close(): Promise<void> {
		const session = this.#session;
		if (!session) return;
		if (this.#willBegin) session.off("Browser.downloadWillBegin", this.#willBegin);
		if (this.#progress) session.off("Browser.downloadProgress", this.#progress);
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new ToolError("Tab closed while waiting for a download"));
		}
		this.#session = undefined;
		await session.detach().catch(() => undefined);
	}

	async #attach(): Promise<void> {
		const session = await this.#browser.target().createCDPSession();
		this.#willBegin = event => {
			// Every session hears every download in the browser; keep the ones this tab's frames started.
			if (!this.#page.frames().some(frame => devtoolsFrameId(frame) === event.frameId)) return;
			this.#pending.set(event.guid, { ...event, receivedBytes: 0 });
		};
		this.#progress = event => {
			const pending = this.#pending.get(event.guid);
			if (!pending) return;
			pending.receivedBytes = event.receivedBytes;
			if (event.state === "inProgress") return;
			this.#pending.delete(event.guid);
			if (event.state === "canceled") {
				this.#deliver({ error: new ToolError(`Download canceled: ${pending.url}`) });
				return;
			}
			void this.#complete(pending, event.filePath).catch(error => {
				this.#fail(pending, toError(error).message);
			});
		};
		session.on("Browser.downloadWillBegin", this.#willBegin);
		session.on("Browser.downloadProgress", this.#progress);
		this.#session = session;
	}

	async #complete(pending: PendingDownload, filePath: string | undefined): Promise<void> {
		const directory = this.#directory ?? this.#defaultDirectory;
		const staging = this.#stagingDirectory;
		const source =
			filePath ?? (staging ? path.join(staging, pending.guid) : path.join(directory, pending.suggestedFilename));
		let sourceFound = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await fs.stat(source);
				sourceFound = true;
				break;
			} catch {
				await Bun.sleep(10);
			}
		}
		const report = (downloadPath: string) =>
			this.#deliver({
				download: {
					path: downloadPath,
					suggestedFilename: pending.suggestedFilename,
					url: pending.url,
					bytes: pending.receivedBytes,
				},
			});
		// A browser the user drives keeps its downloads where Chromium saved them.
		if (!staging) {
			report(source);
			return;
		}
		if (!sourceFound) {
			this.#fail(pending, `completed file was not found: ${source}`);
			return;
		}
		// The peer names the GUID and the saved path, so only a regular file saved under its GUID may move.
		if (!(await isGuidDownload(source, pending.guid))) {
			this.#fail(pending, `${source} is not a file saved under its download GUID; left it in place`);
			return;
		}
		const name = typeof pending.suggestedFilename === "string" ? path.basename(pending.suggestedFilename) : "";
		// Staging goes when the browser does, so an unusable name, or one a directory or symlink holds, moves under the GUID.
		let target = path.join(directory, name !== "" && name !== "." && name !== ".." ? name : pending.guid);
		if ((await entryKind(target)) === "other") target = path.join(directory, pending.guid);
		if ((await entryKind(target)) === "other") {
			this.#fail(pending, `${target} is not a file it may replace; left it at ${source}`);
			return;
		}
		try {
			await moveDownload(source, target);
		} catch (error) {
			this.#fail(pending, `could not move it into ${directory}: ${toError(error).message}; left it at ${source}`);
			return;
		}
		report(target);
	}

	#fail(pending: PendingDownload, reason: string): void {
		this.#deliver({ error: new ToolError(`Download failed: ${pending.url}: ${reason}`) });
	}

	/** Hand an outcome to the oldest waiter, or queue it, failures in order with successes, for the next `wait()`. */
	#deliver(outcome: DownloadOutcome): void {
		if ("download" in outcome) this.#completed.push(outcome.download);
		const waiter = this.#waiters.shift();
		if (!waiter) {
			this.#unclaimed.push(outcome);
			return;
		}
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		if ("error" in outcome) waiter.reject(outcome.error);
		else waiter.resolve({ ...outcome.download });
	}

	#removeWaiter(waiter: DownloadWaiter): void {
		const index = this.#waiters.indexOf(waiter);
		if (index >= 0) this.#waiters.splice(index, 1);
	}
}

/** Whether `source` is a regular file, not a symlink or directory, saved under a UUID-shaped download GUID. */
async function isGuidDownload(source: string, guid: string): Promise<boolean> {
	if (!DOWNLOAD_GUID.test(guid) || path.basename(source) !== guid) return false;
	return (await entryKind(source)) === "file";
}

/** What a path names, without following a symlink there. */
async function entryKind(file: string): Promise<"file" | "missing" | "other"> {
	try {
		return (await fs.lstat(file)).isFile() ? "file" : "other";
	} catch (error) {
		return isEnoent(error) ? "missing" : "other";
	}
}

/**
 * POSIX: create `directory` owned by this user with mode 0700, or fail closed on an existing one that is not; a chmod
 * by path could follow a symlink swapped in after the check. Windows: only the directory type is checked, and the
 * folder inherits its parent's ACL; every parent used (the temp profile under %TEMP%, the shared profile under the OMP
 * state dir, the puppeteer dir) is inside the user's own profile.
 */
async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
	await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
		if (!hasFsCode(error, "EEXIST")) throw error;
	});
	const stats = await fs.lstat(directory);
	if (!stats.isDirectory()) throw new ToolError(`Download staging path is not a directory: ${directory}`);
	if (process.platform === "win32") return;
	if (stats.uid !== process.getuid?.()) {
		throw new ToolError(`Download staging directory is owned by another user: ${directory}`);
	}
	// Chromium must create and list files in it; a folder without owner rwx would fail each download later instead.
	if ((stats.mode & 0o077) !== 0 || (stats.mode & 0o700) !== 0o700) {
		throw new ToolError(`Download staging directory is open to other users or not usable by its owner: ${directory}`);
	}
}

/** Move a completed download into a tab's folder, replacing a same-named file as Chromium's own saves do. */
async function moveDownload(source: string, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await replaceFileAtomically(source, target);
	} catch (error) {
		if (!hasFsCode(error, "EXDEV")) throw error;
		await replaceFileAcrossDevices(source, target);
	}
}
