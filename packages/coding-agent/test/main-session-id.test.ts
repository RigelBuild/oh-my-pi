import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, resolveForeignSessionSource } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const stubSettings = { get: () => undefined } as unknown as Settings;

function args(extra: Partial<Args>): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), unrecognizedFlags: [], ...extra };
}

async function jsonlFiles(dir: string): Promise<string[]> {
	return (await fsp.readdir(dir)).filter(f => f.endsWith(".jsonl"));
}

describe("--session-id", () => {
	let cwd: string;
	let sessionDir: string;

	beforeEach(async () => {
		cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		sessionDir = path.join(cwd, "sessions");
	});
	afterEach(async () => {
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("parses the flag", () => {
		expect(parseArgs(["--session-id", "abc-123"]).sessionId).toBe("abc-123");
	});

	it("creates a new session whose header id is exactly the given id", async () => {
		const id = "0e5d4c3b-2a19-4f00-8000-000000000001";
		const manager = await createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings);
		expect(manager?.getSessionId()).toBe(id);
		manager!.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager!.rewriteEntries();
		const files = await jsonlFiles(sessionDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toContain(id);
	});

	it("reopens the existing session with that id instead of creating a new file", async () => {
		const id = "0e5d4c3b-2a19-4f00-8000-000000000002";
		const first = await createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings);
		first!.appendMessage({ role: "user", content: "remember me", timestamp: Date.now() });
		await first!.rewriteEntries();
		const firstFile = first!.getSessionFile();

		const second = await createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings);
		expect(second?.getSessionId()).toBe(id);
		expect(second?.getSessionFile()).toBe(firstFile);
		expect(second?.getEntries().some(e => e.type === "message")).toBe(true);
		expect(await jsonlFiles(sessionDir)).toHaveLength(1);
	});

	it("marks a reopened session as a restore so its model and thinking level are kept", async () => {
		const id = "0e5d4c3b-2a19-4f00-8000-000000000004";
		const first = await createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings);
		first!.appendMessage({ role: "user", content: "remember me", timestamp: Date.now() });
		await first!.rewriteEntries();

		const reopened = args({ sessionId: id, sessionDir });
		await createSessionManager(reopened, cwd, stubSettings);
		expect(reopened.continue).toBe(true);

		const fresh = args({ sessionId: "0e5d4c3b-2a19-4f00-8000-000000000005", sessionDir });
		await createSessionManager(fresh, cwd, stubSettings);
		expect(fresh.continue).toBeFalsy();
	});

	it("matches the exact id, never a prefix", async () => {
		const existing = SessionManager.create(cwd, sessionDir);
		existing.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		await existing.rewriteEntries();
		const prefix = existing.getSessionId().slice(0, 8);

		const manager = await createSessionManager(args({ sessionId: prefix, sessionDir }), cwd, stubSettings);
		expect(manager?.getSessionId()).toBe(prefix);
		expect(manager?.getSessionFile()).not.toBe(existing.getSessionFile());
	});

	it("gives a fork the requested id", async () => {
		const source = SessionManager.create(cwd, sessionDir);
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		await source.rewriteEntries();
		const id = "0e5d4c3b-2a19-4f00-8000-000000000003";

		const fork = await createSessionManager(
			args({ fork: source.getSessionFile()!, sessionId: id, sessionDir }),
			cwd,
			stubSettings,
		);
		expect(fork?.getSessionId()).toBe(id);
		expect(fork?.getHeader()?.parentSession).toBe(source.getSessionId());
	});

	it("refuses a fork onto an id that already exists", async () => {
		const source = SessionManager.create(cwd, sessionDir);
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		await source.rewriteEntries();

		await expect(
			createSessionManager(
				args({ fork: source.getSessionFile()!, sessionId: source.getSessionId(), sessionDir }),
				cwd,
				stubSettings,
			),
		).rejects.toMatchObject({ name: "SessionResolutionError", message: expect.stringContaining("already exists") });
	});

	it.each([
		[{ resume: "abc" }, "--resume"],
		[{ continue: true }, "--continue"],
		[{ noSession: true }, "--no-session"],
	] as const)("rejects combination with %o", async (extra, flag) => {
		await expect(
			createSessionManager(args({ sessionId: "abc", sessionDir, ...extra }), cwd, stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: `--session-id cannot be combined with ${flag}`,
		});
	});

	it.each(["", "-lead", "trail-", "has/slash", "has space", "../up"])("rejects invalid id %p", async id => {
		await expect(createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings)).rejects.toMatchObject({
			name: "SessionResolutionError",
		});
	});

	it("rejects an invalid id at the SessionManager API too", async () => {
		expect(() => SessionManager.create(cwd, sessionDir, undefined, { id: "x/../../escape" })).toThrow();
		const source = SessionManager.create(cwd, sessionDir);
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		await source.rewriteEntries();
		await expect(
			SessionManager.forkFrom(source.getSessionFile()!, cwd, sessionDir, undefined, { id: "../escape" }),
		).rejects.toThrow();
	});
});

describe("--session-id with a foreign session import", () => {
	it.each([["fromClaude"], ["fromCodex"]] as const)("rejects %s", key => {
		expect(() => resolveForeignSessionSource(args({ sessionId: "abc", [key]: true }))).toThrow(/--session-id/);
	});
});
