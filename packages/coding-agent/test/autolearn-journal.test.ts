import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_AUTOLEARN_SECRET_PATTERNS } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

	it("never overwrites an existing lesson: link() failure is a tool error", async () => {
		const tool = new ManageSkillTool(undefined, journal);
		const first = await tool.execute("dup", { action: "create", name: "a", description: "d", body: "first" });
		expect(first.isError).toBeUndefined();
		const [lesson] = await fs.readdir(journalDir);
		// Same session, tool call and second: the second publish targets the same name.
		const second = await tool.execute("dup", { action: "create", name: "a", description: "d", body: "second" });
		const files = await fs.readdir(journalDir);
		if (files.length === 1) {
			expect(second.isError).toBe(true);
			expect(await fs.readFile(path.join(journalDir, lesson ?? ""), "utf8")).toContain("first");
		} else {
			// The clock crossed a second boundary; force the collision directly.
			const target = files.find(f => f !== lesson) ?? "";
			const third = await new ManageSkillTool(undefined, {
				...journal,
				beforePublish: async tempPath => {
					await fs.copyFile(tempPath, path.join(journalDir, target.replace(/\.md$/, "") + ".md"));
				},
			}).execute("dup", { action: "create", name: "a", description: "d", body: "third" });
			expect(third.isError).toBe(true);
		}
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
