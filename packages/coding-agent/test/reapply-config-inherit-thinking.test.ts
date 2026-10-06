/**
 * `--reapply-config` and the `inherit` thinking spelling: `inherit` names no
 * thinking knob, so the session's persisted level must survive it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("--reapply-config inherit thinking selector", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-inherit-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-reapply-inherit-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function anthropicModel(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	/** A resumable session that persisted its own thinking selection. */
	async function writeBakedSession(bakedModelValue: string, thinkingLevel: string): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `baked-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-inherit-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: bakedModelValue,
					role: "default",
				},
				{
					type: "thinking_level_change",
					id: "thinking-choice",
					parentId: "default-model",
					timestamp,
					thinkingLevel,
					configuredThinkingLevel: thinkingLevel,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	async function loadOverlay(defaultRole: string): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-${Bun.nanoseconds()}.yml`);
		await Bun.write(overlayPath, `modelRoles:\n  default: "${defaultRole}"\n`);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function resume(sessionFile: string, settings: Settings): Promise<AgentSession> {
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			reapplyConfig: true,
		});
		session = result.session;
		return result.session;
	}

	it("keeps the session's thinking level when the configured default resolves with an inherit suffix", async () => {
		const configured = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(anthropicModel("claude-opus-4-1")), "high");

		// A resolved role reports `inherit` as explicit, yet it names no knob.
		const settings = await loadOverlay(`${modelValue(configured)}:inherit`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.id).toBe(configured.id);
		expect(resumed.configuredThinkingLevel()).toBe(ThinkingLevel.High);
	});

	it("still adopts a configured thinking level that names a real knob", async () => {
		// The inverse: a genuine suffix still overrides the session's level.
		const configured = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(anthropicModel("claude-opus-4-1")), "high");

		const settings = await loadOverlay(`${modelValue(configured)}:low`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.id).toBe(configured.id);
		expect(resumed.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
	});

	it("keeps the session's thinking level when an unresolved configured default carries inherit", async () => {
		const baked = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(baked), "high");

		const settings = await loadOverlay("anthropic/no-such-model-xyz:inherit");

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.id).toBe(baked.id);
		expect(resumed.configuredThinkingLevel()).toBe(ThinkingLevel.High);
	});
});
