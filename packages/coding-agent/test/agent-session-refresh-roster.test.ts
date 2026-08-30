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

async function makeHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-roster-");
	const cwd = tempDir.path();
	// A repo root so project-scoped RULES.md discovery walks up and stops here.
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
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
});
