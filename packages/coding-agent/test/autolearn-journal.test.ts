import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cfgAutolearnJournalDir,
	DEFAULT_AUTOLEARN_SECRET_PATTERNS,
	resolveAutolearnPath,
} from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, type Skill, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	compileSecretPatterns,
	type ManageSkillJournal,
	ManageSkillTool,
} from "@oh-my-pi/pi-coding-agent/tools/manage-skill";
import { Snowflake } from "@oh-my-pi/pi-utils";

async function managedSnapshot(): Promise<string[]> {
	return fs.readdir(getManagedSkillsDir(), { recursive: true }).catch(() => []);
}

describe("manage_skill journal mode", () => {
	let journalDir: string;
	let journal: ManageSkillJournal;

	beforeEach(async () => {
		journalDir = path.join(os.tmpdir(), `pi-autolearn-journal-${Snowflake.next()}`);
		journal = {
			journalDir,
			secretPatterns: compileSecretPatterns(DEFAULT_AUTOLEARN_SECRET_PATTERNS),
			sessionId: "sess-1",
			cwd: "/work",
		};
	});

	afterEach(async () => {
		await fs.rm(journalDir, { recursive: true, force: true });
	});

	it("is not registered on the main turn when journalDir is set", () => {
		const settings = Settings.isolated({ "autolearn.enabled": true, "autolearn.journalDir": "/tmp/j" });
		expect(ManageSkillTool.createIf({ settings } as unknown as ToolSession)).toBeNull();
		const plain = Settings.isolated({ "autolearn.enabled": true });
		expect(ManageSkillTool.createIf({ settings: plain } as unknown as ToolSession)).not.toBeNull();
	});

	it("writes one lesson per create, update and delete and leaves managed skills unchanged", async () => {
		const before = await managedSnapshot();
		const tool = new ManageSkillTool(undefined, journal);
		const lessonBody = "Use rjc submit, not git push.";
		const created = await tool.execute("call-c", {
			action: "create",
			name: "jj-flow",
			description: "jj flow",
			body: lessonBody,
		});
		const updated = await tool.execute("call-u", {
			action: "update",
			name: "jj-flow",
			description: "jj flow v2",
			body: "v2",
		});
		const deleted = await tool.execute("call-d", { action: "delete", name: "jj-flow" });
		for (const result of [created, updated, deleted]) expect(result.isError).toBeUndefined();

		const files = (await fs.readdir(journalDir)).sort();
		expect(files).toHaveLength(3);
		for (const file of files) expect(file).toMatch(/^\d{8}T\d{6}Z-sess-1-call-[cud]\.md$/);
		const createdText = await fs.readFile(
			path.join(journalDir, files.find(f => f.endsWith("call-c.md")) ?? ""),
			"utf8",
		);
		expect(createdText).toContain('session: "sess-1"');
		expect(createdText).toContain('tool_call: "call-c"');
		expect(createdText).toContain('cwd: "/work"');
		expect(createdText).toContain("action: create");
		expect(createdText).toContain('name: "jj-flow"');
		expect(createdText).toContain("authored: false");
		expect(createdText).toContain('description: "jj flow"');
		expect(createdText).toContain(lessonBody);
		expect(await managedSnapshot()).toEqual(before);
	});

	it("leaves two lessons for two updates of one name", async () => {
		const tool = new ManageSkillTool(undefined, journal);
		await tool.execute("u1", { action: "update", name: "same", description: "d", body: "one" });
		await tool.execute("u2", { action: "update", name: "same", description: "d", body: "two" });
		expect(await fs.readdir(journalDir)).toHaveLength(2);
	});

	it("never overwrites an existing lesson: link() failure is a tool error and leaves no temp file", async () => {
		// Pre-create the exact lesson name the tool is about to publish, so link() must fail with EEXIST
		// regardless of the clock. The existing file's content must survive.
		const existing = path.join(journalDir, "occupied.md");
		await fs.mkdir(journalDir, { recursive: true });
		await fs.writeFile(existing, "first");
		const tool = new ManageSkillTool(undefined, {
			...journal,
			beforePublish: async tempPath => {
				await fs.link(existing, tempPath.replace(/\.tmp-[^/]*$/, ""));
			},
		});
		const result = await tool.execute("dup", { action: "create", name: "a", description: "d", body: "second" });
		expect(result.isError).toBe(true);
		expect(await fs.readFile(existing, "utf8")).toBe("first");
		expect((await fs.readdir(journalDir)).filter(f => f.includes(".tmp-"))).toHaveLength(0);
	});

	it("leaves only a *.tmp-* file and returns an error when publishing fails after the temp write", async () => {
		const tool = new ManageSkillTool(undefined, {
			...journal,
			beforePublish: async () => {
				throw new Error("injected failure");
			},
		});
		const result = await tool.execute("call-x", { action: "create", name: "x", description: "d", body: "b" });
		expect(result.isError).toBe(true);
		const files = await fs.readdir(journalDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.md\.tmp-/);
	});
	it("refuses a secret in the lesson name and never echoes the name", async () => {
		const tool = new ManageSkillTool(undefined, journal);
		const secret = `ghp_${"B".repeat(36)}`;
		const result = await tool.execute("call-n", {
			action: "create",
			name: `leak-${secret}`,
			description: "d",
			body: "clean body",
		});
		expect(result.isError).toBe(true);
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("ghp_");
		expect(text).not.toContain(secret);
		expect(JSON.stringify(result.details)).not.toContain(secret);
		expect(
			await fs.stat(journalDir).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
	it("writes authored: true when the create name is claimed by an authored skill", async () => {
		const authored: Skill = {
			name: "demo",
			description: "An authored demo skill.",
			filePath: path.join(journalDir, "authored", "demo", "SKILL.md"),
			baseDir: path.join(journalDir, "authored", "demo"),
			source: "native:user",
			_source: { provider: "native", providerName: "Pi", path: path.join(journalDir, "SKILL.md"), level: "user" },
		};
		setActiveSkills([authored]);
		try {
			const tool = new ManageSkillTool(undefined, journal);
			const result = await tool.execute("call-a", { action: "create", name: "demo", description: "d", body: "b" });
			expect(result.isError).toBeUndefined();
			expect(result.details).toMatchObject({ authored: true });
			const [file] = await fs.readdir(journalDir);
			expect(await fs.readFile(path.join(journalDir, file ?? ""), "utf8")).toContain("authored: true");
		} finally {
			resetActiveSkillsForTests();
		}
	});

	it("expands a leading ~ in journalDir to the home directory, not a literal ./~ directory", async () => {
		const home = os.homedir();
		const relative = `pi-journal-tilde-${Snowflake.next()}`;
		const resolved = path.join(home, relative);
		try {
			const settings = Settings.isolated({
				"autolearn.enabled": true,
				"autolearn.journalDir": `~/${relative}`,
			});
			const dir = resolveAutolearnPath(cfgAutolearnJournalDir.get(settings) ?? "");
			expect(dir).toBe(resolved);
			expect(dir.includes("~")).toBe(false);
		} finally {
			await fs.rm(resolved, { recursive: true, force: true });
		}
	});

	it("passes task-: the sk- pattern is word-anchored and does not match inside a longer word", async () => {
		const tool = new ManageSkillTool(undefined, journal);
		const result = await tool.execute("call-t", {
			action: "create",
			name: "task-runner",
			description: "Runs the task-queue and disk-cleanup and risk-review",
			body: "Use the task-runner for the disk-check and risk-report.",
		});
		expect(result.isError).toBeUndefined();
	});

	it("refuses an sk- key at a word boundary", async () => {
		const tool = new ManageSkillTool(undefined, journal);
		const secret = `sk-${"abc".repeat(10)}`;
		const result = await tool.execute("call-k", {
			action: "create",
			name: "key-note",
			description: "d",
			body: `key is ${secret}`,
		});
		expect(result.isError).toBe(true);
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("sk-");
		expect(text).not.toContain(secret);
	});
	for (const [label, secret, pattern] of [
		["GitHub token", `ghp_${"A".repeat(36)}`, "ghp_"],
		["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "eyJ"],
	] as const) {
		it(`writes no file for a body containing a fake ${label} and names the class, not the value`, async () => {
			const tool = new ManageSkillTool(undefined, journal);
			const result = await tool.execute("call-s", {
				action: "create",
				name: "leaky",
				description: "d",
				body: `token is ${secret}`,
			});
			expect(result.isError).toBe(true);
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
			expect(text).toContain(pattern);
			expect(text).not.toContain(secret);
			expect(
				await fs.stat(journalDir).then(
					() => true,
					() => false,
				),
			).toBe(false);
		});
	}
});
