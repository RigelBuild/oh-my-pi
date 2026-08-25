import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { getActiveRules, resetActiveRulesForTests } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
// Register the discovery providers (skills/rules) as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { resetActiveSkillsForTests } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { RuleProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/rule-protocol";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";

function createModel() {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function skillUrl(name: string): InternalUrl {
	return Object.assign(new URL(`skill://${name}`), { rawHost: name }) as InternalUrl;
}

function ruleUrl(name: string): InternalUrl {
	return Object.assign(new URL(`rule://${name}`), { rawHost: name }) as InternalUrl;
}

function writeSkill(dir: string, name: string, description: string): void {
	const file = path.join(dir, name, "SKILL.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill body.\n`);
}

function writeRule(dir: string, name: string, description: string, body: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n\n${body}\n`);
}

describe("AgentSession roster refresh (skills + rules)", () => {
	let tempHome: string;
	let cwd: string;
	let originalAgentDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		// cwd MUST live under the fake home so the discovery walk-up is bounded and
		// cannot pick up ambient ~/.agents or /tmp fixtures (full-suite-safe).
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-roster-refresh-home-"));
		cwd = path.join(tempHome, "project");
		fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
		spyOn(os, "homedir").mockReturnValue(tempHome);
		originalAgentDir = process.env.PI_CODING_AGENT_DIR ?? "";
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		resetCapabilities();
		resetActiveSkillsForTests();
		resetActiveRulesForTests();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		spyOn(os, "homedir").mockRestore();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		resetCapabilities();
		resetActiveSkillsForTests();
		resetActiveRulesForTests();
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	function createSession(): AgentSession {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			modelRegistry: {} as never,
			toolRegistry: new Map(),
			// A real TtsrManager is required for the roster path to run; without one
			// refresh("skills"/"rules") is a documented no-op.
			ttsrManager: new TtsrManager(settings.getGroup("ttsr")),
			skillsSettings: settings.getGroup("skills"),
		});
		sessions.push(session);
		return session;
	}

	it("resolves a skill added on disk only AFTER refresh('skills')", async () => {
		const session = createSession();
		const skillsDir = path.join(cwd, ".agents", "skills");
		const handler = new SkillProtocolHandler();

		// Before any skill exists on disk, the per-session snapshot is empty and
		// the resolve throws Unknown skill.
		await expect(handler.resolve(skillUrl("late-skill"), { skills: session.skills })).rejects.toThrow(
			/Unknown skill: late-skill/,
		);

		// A new skill lands on disk mid-session (a nix sync, a merged PR).
		writeSkill(skillsDir, "late-skill", "A skill added after the session started.");

		// Still stale — nothing re-scanned the roster yet.
		await expect(handler.resolve(skillUrl("late-skill"), { skills: session.skills })).rejects.toThrow(
			/Unknown skill: late-skill/,
		);

		const result = await session.refresh("skills");
		expect(result.skills).toBeGreaterThanOrEqual(1);

		// After refresh, the fresh snapshot binds the new skill and it resolves.
		const resource = await handler.resolve(skillUrl("late-skill"), { skills: session.skills });
		expect(resource.content).toContain("Skill body.");
		expect(session.skills.some(s => s.name === "late-skill")).toBe(true);
	});

	it("resolves a rule added on disk only AFTER refresh('rules') via rule://", async () => {
		const session = createSession();
		const rulesDir = path.join(cwd, ".agents", "rules");
		const handler = new RuleProtocolHandler();

		// rule:// reads the process-global getActiveRules(); before a reload it is
		// empty, so the resolve throws Unknown rule.
		await expect(handler.resolve(ruleUrl("late-rule"))).rejects.toThrow(/Unknown rule: late-rule/);

		writeRule(rulesDir, "late-rule", "A rulebook rule added mid-session.", "Follow the late rule.");

		await expect(handler.resolve(ruleUrl("late-rule"))).rejects.toThrow(/Unknown rule: late-rule/);

		const result = await session.refresh("rules");
		expect(result.rules).toBeGreaterThanOrEqual(1);

		const resource = await handler.resolve(ruleUrl("late-rule"));
		expect(resource.content).toContain("Follow the late rule.");
		expect(getActiveRules().some(r => r.name === "late-rule")).toBe(true);
	});

	it("does not write any config file during a roster reload", async () => {
		const session = createSession();
		writeSkill(path.join(cwd, ".agents", "skills"), "probe-skill", "Probe.");
		writeRule(path.join(cwd, ".agents", "rules"), "probe-rule", "Probe rule.", "Probe body.");

		// Snapshot the entire temp tree (path -> mtimeMs) before the reload.
		const snapshot = new Map<string, number>();
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else snapshot.set(full, fs.statSync(full).mtimeMs);
			}
		};
		walk(tempHome);

		await session.refresh("all");

		// No file created, deleted, or rewritten by the reload.
		const after = new Map<string, number>();
		const walkAfter = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walkAfter(full);
				else after.set(full, fs.statSync(full).mtimeMs);
			}
		};
		walkAfter(tempHome);

		expect([...after.keys()].sort()).toEqual([...snapshot.keys()].sort());
		for (const [file, mtime] of snapshot) {
			expect(after.get(file)).toBe(mtime);
		}
	});

	// Regression (stale capability fs cache): the FIRST refresh reads a rule's
	// bytes into the process-global content cache; an in-place EDIT must be live
	// after the NEXT refresh. Pre-fix, #doRefresh re-ran discovery without
	// clearing that cache, so an edited rulebook served stale bytes while
	// reporting success — the tool's headline case silently broken.
	it("re-reads an EDITED rule's content on a second refresh('rules')", async () => {
		const session = createSession();
		const rulesDir = path.join(cwd, ".agents", "rules");
		const handler = new RuleProtocolHandler();

		writeRule(rulesDir, "edit-rule", "An editable rulebook rule.", "ORIGINAL rule body.");
		await session.refresh("rules");
		const first = await handler.resolve(ruleUrl("edit-rule"));
		expect(first.content).toContain("ORIGINAL rule body.");

		// Same path, new bytes — a supervisor edits the shared rulebook mid-session.
		writeRule(rulesDir, "edit-rule", "An editable rulebook rule.", "REVISED rule body.");
		await session.refresh("rules");

		const second = await handler.resolve(ruleUrl("edit-rule"));
		expect(second.content).toContain("REVISED rule body.");
		expect(second.content).not.toContain("ORIGINAL rule body.");
	});

	// Same regression on the skill surface. The skill DESCRIPTION (frontmatter) is
	// loaded through the cached capability fs path (scanSkillsFromDir -> readFile),
	// unlike the body which skill:// resolve reads fresh via Bun.file — so the
	// description is the surface the stale cache actually corrupts, and it drives
	// the advertised roster/prompt. An edited description must be live after the
	// second refresh('skills').
	it("re-reads an EDITED skill's description on a second refresh('skills')", async () => {
		const session = createSession();
		const file = path.join(cwd, ".agents", "skills", "edit-skill", "SKILL.md");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			"---\nname: edit-skill\ndescription: ORIGINAL description.\n---\n\n# edit-skill\n\nBody.\n",
		);
		await session.refresh("skills");
		expect(session.skills.find(s => s.name === "edit-skill")?.description).toBe("ORIGINAL description.");

		// Same path, new frontmatter — a supervisor edits the shared skill mid-session.
		fs.writeFileSync(
			file,
			"---\nname: edit-skill\ndescription: REVISED description.\n---\n\n# edit-skill\n\nBody.\n",
		);
		await session.refresh("skills");

		expect(session.skills.find(s => s.name === "edit-skill")?.description).toBe("REVISED description.");
	});
});
