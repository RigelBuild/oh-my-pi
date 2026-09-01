/**
 * In-session `refresh` roster wiring, exercised through the real
 * `createAgentSession` SDK path (not a hand-wired session), so it defends the
 * user-visible contracts:
 *
 *   - A rules refresh reaches the model prompt. `rebuildSystemPrompt` renders
 *     from SDK-closure roster locals; without `applyReloadedRoster` wired, a
 *     refresh reports success and rebuilds the SAME stale launch-time roster.
 *   - Editing a rule's BODY without renaming it is detected. `rulesEqual`
 *     compares content identity, not just name+path, so an edited rulebook
 *     entry rebuilds the advertised roster.
 *   - `refresh('all')` discovers skills against the freshly reloaded settings,
 *     not the construction-time snapshot, so a changed `skills.*` config takes
 *     effect on the same refresh.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "refresh-roster-model",
		name: "Refresh Roster Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	dispose: () => Promise<void>;
}

async function makeHarness(
	overrides: Record<string, unknown> = {},
	sdkOverrides: Record<string, unknown> = {},
	seed?: (cwd: string) => Promise<void>,
): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-roster-");
	const cwd = tempDir.path();
	// A repo root so project-scoped RULES.md discovery walks up and stops here.
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	// Stage on-disk config BEFORE the session is constructed, so its initial
	// roster discovery picks these up (exposing bugs where a later settings-only
	// refresh must preserve the construction-time roster).
	if (seed) await seed(cwd);
	const api = `refresh-roster-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false, ...overrides },
		}),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		// contextFiles/skills/rules intentionally omitted so discovery runs on disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		...sdkOverrides,
	});

	return {
		session,
		cwd,
		settingsPath: path.join(cwd, "config.yml"),
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh: roster reaches the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders a newly added always-apply rule into the system prompt after refresh('rules')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleText = `NEWLY_ADDED_RULE_${marker}`;
		const h = await makeHarness();
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).not.toContain(ruleText);

			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			await fs.writeFile(path.join(h.cwd, ".omp", "RULES.md"), `${ruleText}\n`);

			const result = await h.session.refresh("rules");
			expect(result.rules).toBeGreaterThan(0);

			// Pre-fix (stale-roster rebuild), the prompt omitted the new rule even
			// though refresh reported success.
			expect(h.session.systemPrompt.join("\n")).toContain(ruleText);
		} finally {
			await h.dispose();
		}
	});

	it("re-renders an EDITED rule body (same name) into the prompt after refresh('rules')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const original = `ORIGINAL_BODY_${marker}`;
		const edited = `EDITED_BODY_${marker}`;
		const h = await makeHarness();
		try {
			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			const rulesMd = path.join(h.cwd, ".omp", "RULES.md");
			await fs.writeFile(rulesMd, `${original}\n`);
			await h.session.refresh("rules");
			expect(h.session.systemPrompt.join("\n")).toContain(original);

			// Edit the SAME rule's body without renaming: name+path unchanged.
			await fs.writeFile(rulesMd, `${edited}\n`);
			await h.session.refresh("rules");

			const prompt = h.session.systemPrompt.join("\n");
			// Pre-fix (rulesEqual compared only name+path), rosterChanged stayed
			// false and the prompt kept the original body.
			expect(prompt).toContain(edited);
			expect(prompt).not.toContain(original);
		} finally {
			await h.dispose();
		}
	});

	it("re-reads live skills settings before discovery on refresh('all')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const skillName = `refresh-skill-${marker}`;
		const h = await makeHarness();
		try {
			// A project skill under .omp/skills is discoverable on the first refresh.
			await fs.mkdir(path.join(h.cwd, ".omp", "skills", skillName), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "skills", skillName, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: ${skillName} fixture\n---\nbody\n`,
			);
			await h.session.refresh("all");
			expect(h.session.skills.map(s => s.name)).toContain(skillName);

			// Turn skills off on disk. `refresh('all')` reloads settings BEFORE the
			// roster scan, so the disabled config must take effect on THIS refresh.
			await fs.writeFile(h.settingsPath, "skills:\n  enabled: false\n");
			await h.session.refresh("all");

			// Pre-fix (roster scanned with the construction-time skills snapshot
			// and before settings.reload()), the skill stayed loaded.
			expect(h.session.skills.map(s => s.name)).not.toContain(skillName);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a --no-skills roster disabled across refresh (no ambient re-enable)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const skillName = `refresh-skill-${marker}`;
		// SDK `skills: []` (the --no-skills path) marks the roster non-reloadable.
		const h = await makeHarness({}, { skills: [] });
		try {
			// A project skill lands on disk that discovery WOULD pick up.
			await fs.mkdir(path.join(h.cwd, ".omp", "skills", skillName), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "skills", skillName, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: ${skillName} fixture\n---\nbody\n`,
			);
			expect(h.session.skills.map(s => s.name)).not.toContain(skillName);

			await h.session.refresh("all");

			// Pre-fix (refresh scanned disk unconditionally), the ambient skill was
			// re-discovered and enabled even though the session opted out.
			expect(h.session.skills.map(s => s.name)).not.toContain(skillName);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a --no-rules policy across refresh (no ambient rule re-enable)", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleText = `AMBIENT_RULE_${marker}`;
		// SDK `rules: []` (the --no-rules path) supplies an explicit empty policy.
		const h = await makeHarness({}, { rules: [] });
		try {
			await fs.mkdir(path.join(h.cwd, ".omp"), { recursive: true });
			await fs.writeFile(path.join(h.cwd, ".omp", "RULES.md"), `${ruleText}\n`);

			const result = await h.session.refresh("rules");

			// Pre-fix (refresh scanned the rules capability unconditionally), the
			// ambient RULES.md was re-discovered and rendered despite --no-rules.
			expect(result.rules).toBe(0);
			expect(h.session.systemPrompt.join("\n")).not.toContain(ruleText);
		} finally {
			await h.dispose();
		}
	});

	it("refreshes the skill-settings snapshot so enableSkillCommands takes effect", async () => {
		const h = await makeHarness();
		try {
			// Seed the initial value on disk (not a runtime override, which would
			// outrank the reload), then flip it and refresh.
			await fs.writeFile(h.settingsPath, "skills:\n  enableSkillCommands: false\n");
			await h.session.refresh("all");
			expect(h.session.skillsSettings?.enableSkillCommands).toBe(false);

			await fs.writeFile(h.settingsPath, "skills:\n  enableSkillCommands: true\n");
			await h.session.refresh("all");

			// Pre-fix (refresh left #skillsSettings at the construction snapshot),
			// the session kept reporting the stale enableSkillCommands value.
			expect(h.session.skillsSettings?.enableSkillCommands).toBe(true);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh: settings-only TTSR gating reconcile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops a disabled condition rule from triggering after refresh('settings')", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `no-foo-${marker}`;
		const trigger = `FORBIDDEN_${marker}`;
		const h = await makeHarness();
		try {
			// A condition-bearing rule on disk, discovered by a rules refresh: it
			// registers with the TTSR manager and triggers on its condition.
			await fs.mkdir(path.join(h.cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(h.cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
			await h.session.refresh("rules");
			const mgr = h.session.ttsrManager;
			expect(mgr).toBeDefined();
			expect(mgr?.hasRule(ruleName)).toBe(true);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" }).map(r => r.name)).toEqual([ruleName]);
			mgr?.resetBuffer();

			// Disable the rule on disk and refresh ONLY settings — never the roster.
			// The gating field must take effect without a disk rediscovery.
			await fs.writeFile(h.settingsPath, `ttsr:\n  disabledRules:\n    - ${ruleName}\n`);
			await h.session.refresh("settings");

			// Pre-fix (reconfigure stored disabledRules but matching never read it,
			// and the roster re-bucket that enforces it never runs on a settings
			// refresh), the disabled rule kept triggering.
			expect(mgr?.hasRule(ruleName)).toBe(false);
			expect(mgr?.checkDelta(`has ${trigger} token`, { source: "text" })).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("preserves non-TTSR rules on a settings-only refresh, dropping only the newly-gated rule", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const keepName = `keep-me-${marker}`;
		const ttsrName = `no-foo-${marker}`;
		const trigger = `FORBIDDEN_${marker}`;
		// Seed BOTH rules on disk before construction so the session's initial
		// roster holds the non-TTSR (always-apply) rule AND registers the TTSR
		// condition rule — never populated by a settings-only refresh.
		const h = await makeHarness({}, {}, async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${keepName}.md`),
				`---\nname: ${keepName}\nalwaysApply: true\n---\nkeep body\n`,
			);
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ttsrName}.md`),
				`---\nname: ${ttsrName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			// Both rules are live in the published active set after construction.
			expect(getActiveRules().map(r => r.name)).toEqual(expect.arrayContaining([keepName, ttsrName]));

			// Disable ONLY the TTSR condition rule on disk, then refresh settings —
			// never the roster.
			await fs.writeFile(h.settingsPath, `ttsr:\n  disabledRules:\n    - ${ttsrName}\n`);
			await h.session.refresh("settings");

			const activeNames = getActiveRules().map(r => r.name);
			// Pre-fix: `#rosterRules` was empty, so the re-bucket rebuilt from TTSR
			// entries alone and republished an empty rulebook/always set — the
			// non-TTSR always-apply rule vanished from the active rules.
			expect(activeNames).toContain(keepName);
			// The newly-gated TTSR rule is the only one dropped.
			expect(activeNames).not.toContain(ttsrName);
			expect(h.session.ttsrManager?.hasRule(ttsrName)).toBe(false);
		} finally {
			await h.dispose();
		}
	});
});
