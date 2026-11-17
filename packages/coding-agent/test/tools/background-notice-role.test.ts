import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

let cwd: string;
let manager: AsyncJobManager;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-notice-role-"));
	manager = new AsyncJobManager({});
});

afterEach(async () => {
	await manager.dispose();
	await fs.rm(cwd, { recursive: true, force: true });
});

/** Bash session fixture; `taskDepth` set marks it a subagent, as the executor does. */
function bashSession(taskDepth: number | undefined): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
		...(taskDepth === undefined ? {} : { taskDepth }),
	};
}

describe("bash background notice by session role", () => {
	it.skipIf(process.platform === "win32")("keeps the top-level wake promise", async () => {
		const tool = new BashTool(bashSession(undefined));
		const result = await tool.execute("notice-top", { command: "sleep 5", async: true, timeout: 0 });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("wait to be woken");
		expect(text).toContain("injected into the conversation");
	});

	it.skipIf(process.platform === "win32")("tells a subagent to call wait instead of promising a wake", async () => {
		const tool = new BashTool(bashSession(1));
		const result = await tool.execute("notice-sub", { command: "sleep 5", async: true, timeout: 0 });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).not.toContain("wait to be woken");
		expect(text).toContain("call `wait`");
		expect(text).toContain("while this run is still live");
	});
});
