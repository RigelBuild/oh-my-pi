import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, resolveForeignSessionSource } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const stubSettings = Settings.isolated();

function args(extra: Partial<Args> & { sessionId?: string }): Args & { sessionId?: string } {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map<string, boolean | string>(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
		...extra,
	};
}

async function jsonlFiles(dir: string): Promise<string[]> {
	return (await fsp.readdir(dir)).filter(file => file.endsWith(".jsonl"));
}

describe("--session-id", () => {
	let cwd: string;
	let sessionDir: string;
	const managers: SessionManager[] = [];

	beforeEach(async () => {
		cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		sessionDir = path.join(cwd, "sessions");
	});

	afterEach(async () => {
		for (const manager of managers.splice(0).reverse()) await manager.close();
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("creates a session with the exact requested id", async () => {
		const id = "seat-1";
		const manager = await createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings);
		if (!manager) throw new Error("Expected a session manager");
		managers.push(manager);

		expect(manager.getSessionId()).toBe(id);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager.rewriteEntries();
		const files = await jsonlFiles(sessionDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toEndWith(`_${id}.jsonl`);
	});

	it("reopens only an exact matching session ID", async () => {
		const id = "seat-2";
		const first = SessionManager.create(cwd, sessionDir, undefined, { id });
		managers.push(first);
		first.appendMessage({ role: "user", content: "remember me", timestamp: Date.now() });
		await first.rewriteEntries();
		const firstFile = first.getSessionFile();

		const second = await createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings);
		if (!second) throw new Error("Expected the existing session to reopen");
		managers.push(second);
		expect(second.getSessionId()).toBe(id);
		expect(second.getSessionFile()).toBe(firstFile);
		expect(second.getEntries().some(entry => entry.type === "message")).toBe(true);
		expect(await jsonlFiles(sessionDir)).toHaveLength(1);

		const prefix = id.slice(0, 4);
		const prefixManager = await createSessionManager(args({ sessionId: prefix, sessionDir }), cwd, stubSettings);
		if (!prefixManager) throw new Error("Expected a new session for a non-exact id");
		managers.push(prefixManager);
		expect(prefixManager.getSessionId()).toBe(prefix);
		expect(prefixManager.getSessionFile()).not.toBe(firstFile);
	});

	it("marks an existing session with history as resumed", async () => {
		const id = "seat-restore";
		const source = SessionManager.create(cwd, sessionDir, undefined, { id });
		managers.push(source);
		source.appendMessage({ role: "user", content: "remember me", timestamp: Date.now() });
		await source.rewriteEntries();

		const reopenedArgs = args({ sessionId: id, sessionDir });
		const reopened = await createSessionManager(reopenedArgs, cwd, stubSettings);
		if (!reopened) throw new Error("Expected the existing session to reopen");
		managers.push(reopened);
		expect(reopenedArgs.continue).toBe(true);

		const emptyArgs = args({ sessionId: "seat-fresh", sessionDir });
		const fresh = await createSessionManager(emptyArgs, cwd, stubSettings);
		if (!fresh) throw new Error("Expected a newly created session");
		managers.push(fresh);
		expect(emptyArgs.continue).toBeUndefined();
	});

	it("forks with the requested ID and rejects a fork ID collision", async () => {
		const source = SessionManager.create(cwd, sessionDir);
		managers.push(source);
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		await source.rewriteEntries();

		const forkId = "seat-fork";
		const fork = await createSessionManager(
			args({ fork: source.getSessionFile()!, sessionId: forkId, sessionDir }),
			cwd,
			stubSettings,
		);
		if (!fork) throw new Error("Expected a forked session");
		managers.push(fork);
		expect(fork.getSessionId()).toBe(forkId);
		expect(fork.getHeader()?.parentSession).toBe(source.getSessionId());

		await expect(
			createSessionManager(
				args({ fork: source.getSessionFile()!, sessionId: forkId, sessionDir }),
				cwd,
				stubSettings,
			),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: expect.stringContaining("already exists"),
		});
	});

	it.each([
		[{ resume: "seat-1" }, "--resume"],
		[{ continue: true }, "--continue"],
		[{ noSession: true }, "--no-session"],
	] as const)("rejects --session-id combined with %s", async (extra, flag) => {
		await expect(
			createSessionManager(args({ sessionId: "seat-1", sessionDir, ...extra }), cwd, stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: `--session-id cannot be combined with ${flag}`,
		});
	});

	it.each(["", "-leading", "trailing-", "has/slash", "has space", "../escape"])(
		"rejects unsafe ID %p",
		async id => {
			await expect(createSessionManager(args({ sessionId: id, sessionDir }), cwd, stubSettings)).rejects.toMatchObject({
				name: "SessionResolutionError",
			});
		},
	);

	it("validates caller-chosen IDs at SessionManager APIs", async () => {
		expect(() => SessionManager.create(cwd, sessionDir, undefined, { id: "x/../../escape" })).toThrow();
		const source = SessionManager.create(cwd, sessionDir);
		managers.push(source);
		source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
		await source.rewriteEntries();
		await expect(
			SessionManager.forkFrom(source.getSessionFile()!, cwd, sessionDir, undefined, { id: "../escape" }),
		).rejects.toThrow();
	});
});

describe("--session-id with a foreign session import", () => {
	it.each(["fromClaude", "fromCodex"] as const)("rejects %s", key => {
		expect(() => resolveForeignSessionSource(args({ sessionId: "seat-1", [key]: true }))).toThrow(/--session-id/);
	});
});
