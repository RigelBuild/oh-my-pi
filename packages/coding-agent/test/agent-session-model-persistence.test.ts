import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type Api, type AssistantMessage, Effort, type Model, type ServiceTier } from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel, cfgTierOpenai } from "@oh-my-pi/pi-coding-agent/session/settings";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests:
	// every test sets the same anthropic runtime key and only ever reads the bundled model
	// list. Building them once avoids ~12 SQLite opens + registry constructions.
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-persistence-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-persistence-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	async function writeRoleModelSession(
		defaultRoleValue: string,
		smolRoleValue: string,
		lastRole = "smol",
	): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: defaultRoleValue,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: smolRoleValue,
					role: lastRole,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}
	async function createSession(options?: {
		initialModel?: Model<Api>;
		selectInitialModel?: (availableModels: Model<Api>[]) => Model<Api>;
		modelRoles?: Record<string, string>;
		persist?: boolean;
	}): Promise<{ modelRegistry: ModelRegistry; settings: Settings; session: AgentSession }> {
		const modelRegistry = sharedModelRegistry;
		const model =
			options?.initialModel ??
			options?.selectInitialModel?.(modelRegistry.getAvailable()) ??
			getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});

		sessionSettings = Settings.isolated();
		const modelRoles = options?.modelRoles;
		if (modelRoles) {
			for (const role in modelRoles) {
				const modelRoleValue = modelRoles[role];
				if (modelRoleValue !== undefined) {
					sessionSettings.setModelRole(role, modelRoleValue);
				}
			}
		}
		session = new AgentSession({
			agent,
			sessionManager: options?.persist
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"))
				: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		return { modelRegistry, settings: sessionSettings, session };
	}

	async function createStartupResumeSession(
		targetSessionFile: string,
		settings: Settings = Settings.isolated(),
		extraOptions?: {
			reapplyConfig?: boolean;
			model?: Model<Api>;
			thinkingLevel?: ConfiguredThinkingLevel;
			openAIServiceTier?: ServiceTier | null;
			modelRegistry?: ModelRegistry;
		},
	): Promise<CreateAgentSessionResult> {
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: extraOptions?.modelRegistry ?? sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			reapplyConfig: extraOptions?.reapplyConfig,
			model: extraOptions?.model,
			thinkingLevel: extraOptions?.thinkingLevel,
			openAIServiceTier: extraOptions?.openAIServiceTier,
		});
		session = result.session;
		return result;
	}
	async function loadOverlaySettings(overlayModelRoles: Record<string, string | null>): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-${Bun.nanoseconds()}.yml`);
		const roleLines = Object.entries(overlayModelRoles)
			.map(([role, value]) => `  ${role}: ${value === null ? "null" : value}`)
			.join("\n");
		await Bun.write(overlayPath, `modelRoles:\n${roleLines}\n`);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function writeThinkingModelSession(modelValueStr: string, bakedThinking: string): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-thinking-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: modelValueStr,
					role: "default",
				},
				{
					type: "thinking_level_change",
					id: "thinking",
					parentId: "default-model",
					timestamp,
					thinkingLevel: bakedThinking,
					configured: bakedThinking,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}

	it("adopts the config default model over the baked session model on resume with reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const overlayModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });
		expect(settings.getModelRoleProvenance("default")).toBe("overlay");

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(overlayModel.id);
	});

	it("restores the baked session model on a bare resume without reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const overlayModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(bakedModel.id);
	});

	it("ignores a configured model and thinking level on a bare startup resume", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const configModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);
		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(configModel)}\ndefaultThinkingLevel: ${Effort.XHigh}\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("adopts the config default thinking level over the baked session level on resume with reapplyConfig", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(model), Effort.Medium);

		const settings = await loadOverlaySettings({ default: `${modelValue(model)}:xhigh` });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(model.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);
	});

	it("restores the baked session thinking level on a bare resume without reapplyConfig", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(model), Effort.Medium);

		const settings = await loadOverlaySettings({ default: `${modelValue(model)}:xhigh` });

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(model.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("adopts a config defaultThinkingLevel with no role suffix on resume with reapplyConfig", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(model), Effort.Medium);

		// Config names the thinking knob GLOBALLY (`defaultThinkingLevel`) and the
		// default role carries no `:level` suffix. Thinking is its own knob, so
		// --reapply-config must honor the configured value rather than restoring
		// the session's baked level.
		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ndefaultThinkingLevel: ${Effort.XHigh}\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(model.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);
	});

	it("restores the baked session thinking level on a bare resume that configures defaultThinkingLevel", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(model), Effort.Medium);

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ndefaultThinkingLevel: ${Effort.XHigh}\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		// Without the flag the configured level must not reach a resumed session.
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("keeps the baked session thinking level when reapplyConfig names no thinking knob", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(model), Effort.Medium);

		// Config names a default role but no thinking level anywhere, so the
		// per-knob contract keeps the session's own level — the flag must never
		// move it onto a schema default or a bare model default.
		const settings = await loadOverlaySettings({ default: modelValue(model) });
		expect(cfgDefaultThinkingLevel.isConfigured(settings)).toBe(false);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	async function loadOverlaySettingsRaw(overlayYaml: string): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-raw-${Bun.nanoseconds()}.yml`);
		await Bun.write(overlayPath, overlayYaml);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function writeServiceTierSession(modelValueStr: string, tier: string | null): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-tier-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: modelValueStr,
					role: "default",
				},
				{
					type: "service_tier_change",
					id: "tier",
					parentId: "default-model",
					timestamp,
					serviceTier: tier === null ? null : { openai: tier },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}

	it("keeps the baked session model when reapplyConfig resolves no config default", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		// Overlay retunes only a non-default role, naming no `modelRoles.default`.
		const settings = await loadOverlaySettings({ review: `${modelValue(bakedModel)}:xhigh` });
		expect(settings.getModelRole("default")).toBeUndefined();

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// The session model is retained, not discarded onto an arbitrary fallback.
		expect(result.session.model?.id).toBe(bakedModel.id);
	});

	// Self aliases (`*`, `@default`, and `pi/default`) name a role, not a model,
	// so they resolve to nothing. Reapply treats them as an unset model knob and
	// keeps the baked model without reporting a broken config default.
	for (const selfAlias of ["*", "@default", "pi/default"]) {
		it(`treats a "${selfAlias}" default role as an unset model knob under reapplyConfig`, async () => {
			const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const targetSessionFile = await writeRoleModelSession(
				modelValue(bakedModel),
				modelValue(bakedModel),
				"default",
			);

			const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "${selfAlias}"\n`);
			expect(settings.getModelRole("default")).toBe(selfAlias);

			const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

			expect(result.session.model?.id).toBe(bakedModel.id);
			// No config default was named, so there is nothing to warn about.
			expect(result.modelFallbackMessage).toBeUndefined();
		});
	}

	// Suffixed self aliases still name the default role, not a model. Their suffix
	// supplies the thinking knob while the model knob stays unset; treating the
	// full string as a model discards restore and reports a false config failure.
	for (const selfAlias of ["*:xhigh", "@default:low", "pi/default:max"]) {
		it(`treats a "${selfAlias}" default role as an unset model knob under reapplyConfig`, async () => {
			const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const targetSessionFile = await writeRoleModelSession(
				modelValue(bakedModel),
				modelValue(bakedModel),
				"default",
			);

			const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "${selfAlias}"\n`);
			expect(settings.getModelRole("default")).toBe(selfAlias);

			const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

			expect(result.session.model?.id).toBe(bakedModel.id);
			expect(result.modelFallbackMessage).toBeUndefined();
		});
	}

	// Only exact unsuffixed `default` is the sentinel. `default:<level>` resolves
	// to `cursor/default`, a concrete bundled model, which reapply must adopt.
	it("adopts a resolvable suffixed bare `default` config model under reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const cursorDefault = getBundledModel("cursor", "default");
		if (!cursorDefault) throw new Error("Expected cursor/default to exist in the bundled catalog");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		// Credential the provider that supplies the bare `default` id, so the
		// selector genuinely resolves rather than falling through as unresolvable.
		sharedAuthStorage.keys.setRuntime("cursor", "test-cursor-key");
		try {
			const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "default:low"\n`);
			expect(settings.getModelRole("default")).toBe("default:low");

			const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

			expect(result.session.model?.provider).toBe("cursor");
			expect(result.session.model?.id).toBe(cursorDefault.id);
		} finally {
			sharedAuthStorage.keys.removeRuntime("cursor");
		}
	});

	// A suffixed self alias names no model, but it DOES name the thinking knob.
	// The model knob stays unset (the session keeps its own model) while
	// `--reapply-config` adopts the suffix's tier over the session's baked level.
	for (const [selfAlias, expectedLevel] of [
		["*:xhigh", Effort.XHigh],
		["@default:low", Effort.Low],
		["pi/default:high", Effort.High],
	] as const) {
		it(`adopts the "${selfAlias}" default-role thinking suffix under reapplyConfig`, async () => {
			const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
			const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

			const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "${selfAlias}"\n`);
			expect(cfgDefaultThinkingLevel.isConfigured(settings)).toBe(false);

			const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

			expect(result.session.model?.id).toBe(bakedModel.id);
			expect(result.session.configuredThinkingLevel()).toBe(expectedLevel);
		});
	}

	it("keeps the baked thinking level for a bare self-alias default under reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

		// A self alias with no suffix names neither knob, so the session's own
		// level stands: adopting the suffix must not make the bare alias adopt one.
		const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "*"\n`);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	// A model ID can end in a thinking-level name, such as coding-router:low.
	// That saved selector encodes identity only; treating its suffix as thinking
	// would retier the adopted config model without a session thinking choice.
	it("does not adopt a literal model id's own suffix as the session thinking level", async () => {
		const suffixedModelId = "coding-router:low";
		const modelsPath = path.join(tempDir.path(), `models-literal-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			`providers:
  litprov:
    baseUrl: http://localhost:9/v1
    api: openai-completions
    auth: none
    models:
      - id: "${suffixedModelId}"
        name: Coding Router Low
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high, xhigh]
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8192
        maxTokens: 4096
`,
		);
		const modelRegistry = new ModelRegistry(sharedAuthStorage, modelsPath);
		const literalModel = modelRegistry.find("litprov", suffixedModelId);
		if (!literalModel) throw new Error(`Expected litprov/${suffixedModelId} to be a live model id`);

		// The session saved only the literal id — no `thinking_level_change`, so
		// its selector is the only thing the adopt path can read a tier from.
		const targetSessionFile = await writeRoleModelSession(
			`litprov/${suffixedModelId}`,
			`litprov/${suffixedModelId}`,
			"default",
		);
		const adopted = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "${modelValue(adopted)}"\n`);
		expect(cfgDefaultThinkingLevel.isConfigured(settings)).toBe(false);

		const result = await createStartupResumeSession(targetSessionFile, settings, {
			reapplyConfig: true,
			modelRegistry,
		});

		expect(result.session.model?.id).toBe(adopted.id);
		expect(result.session.configuredThinkingLevel()).not.toBe(Effort.Low);
	});

	it("keeps the baked thinking level for a suffixed self-alias default without reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

		const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: "*:xhigh"\n`);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("keeps the baked model but adopts an unresolved default's thinking suffix under reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

		const settings = await loadOverlaySettings({ default: "anthropic/no-such-model-xyz:xhigh" });
		expect(settings.getModelRole("default")).toBe("anthropic/no-such-model-xyz:xhigh");

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// The model knob falls back to the session's; the suffix still names thinking.
		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);
	});

	it("keeps a newline-bearing config default on one notice line", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);
		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: "anthropic/no-such-model\\nWARNING: spoofed\\tline"\n`,
		);
		expect(settings.getModelRole("default")).toContain("\n");

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.modelFallbackMessage).toContain("did not resolve");
		expect(result.modelFallbackMessage).not.toMatch(/[\n\t]/);
	});

	it("lets a resolved later candidate decide thinking over an unresolved earlier suffix", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const configModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const bareFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);
		const suffixedFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

		const bare = await createStartupResumeSession(
			bareFile,
			await loadOverlaySettings({ default: `anthropic/no-such-model-xyz:xhigh,${modelValue(configModel)}` }),
			{ reapplyConfig: true },
		);
		expect(bare.session.model?.id).toBe(configModel.id);
		expect(bare.session.configuredThinkingLevel()).toBe(Effort.Medium);
		await bare.session.dispose();
		session = undefined;

		const suffixed = await createStartupResumeSession(
			suffixedFile,
			await loadOverlaySettings({
				default: `anthropic/no-such-model-xyz:xhigh,${modelValue(configModel)}:${Effort.Low}`,
			}),
			{ reapplyConfig: true },
		);
		expect(suffixed.session.model?.id).toBe(configModel.id);
		expect(suffixed.session.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("keeps adopted model and thinking across a same-session reload, but not across a switch", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const configModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const reappliedFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);
		const otherFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Low);
		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(configModel)}\ndefaultThinkingLevel: ${Effort.XHigh}\n`,
		);

		const result = await createStartupResumeSession(reappliedFile, settings, { reapplyConfig: true });
		expect(result.session.model?.id).toBe(configModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);

		await result.session.reload();
		expect(result.session.model?.id).toBe(configModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);

		await expect(result.session.switchSession(otherFile)).resolves.toBe(true);
		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Low);

		// Coming back is a plain resume of that transcript, not the reapplied startup.
		await expect(result.session.switchSession(reappliedFile)).resolves.toBe(true);
		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("returns to the adopted model on same-session reload after an ephemeral fallback", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const configModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const reappliedFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);
		const otherFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Low);
		const settings = await loadOverlaySettings({ default: modelValue(configModel) });

		const result = await createStartupResumeSession(reappliedFile, settings, { reapplyConfig: true });
		expect(result.session.model?.id).toBe(configModel.id);

		await result.session.setModelTemporary(fallbackModel, undefined, { ephemeral: true });
		expect(result.session.sessionManager.getLastModelChangeRole()).toBe(EPHEMERAL_MODEL_CHANGE_ROLE);

		await result.session.reload();
		expect(result.session.model?.id).toBe(configModel.id);

		await expect(result.session.switchSession(otherFile)).resolves.toBe(true);
		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("lets an explicit model selection after a reapplied startup win on same-session reload", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const configModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const chosenModel = getAnthropicModelOrThrow("claude-opus-4-1");
		const reappliedFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);
		const settings = await loadOverlaySettings({ default: modelValue(configModel) });

		const result = await createStartupResumeSession(reappliedFile, settings, { reapplyConfig: true });
		expect(result.session.model?.id).toBe(configModel.id);

		await result.session.setModel(chosenModel);
		// A later fallback must not hide the explicit choice behind the startup baseline.
		await result.session.setModelTemporary(fallbackModel, undefined, { ephemeral: true });

		await result.session.reload();
		expect(result.session.model?.id).toBe(chosenModel.id);
	});

	it("keeps the baked session thinking level when reapplyConfig is combined with an explicit model", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(model), Effort.Minimal);

		const settings = await loadOverlaySettings({ default: `${modelValue(model)}:xhigh` });

		const result = await createStartupResumeSession(targetSessionFile, settings, {
			reapplyConfig: true,
			model,
		});

		// An explicit --model overrides the config default role, so reapplyConfig must
		// not move the session's thinking level to the config selector or a model
		// default — the session's baked level is kept.
		expect(result.session.model?.id).toBe(model.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Minimal);
	});

	// A saved selector can encode both model identity and thinking. If its suffix
	// is the session's only thinking choice, reapply preserves it when adopting a
	// config model with no thinking setting; parsing must not depend on restoration.
	it("keeps a saved selector's thinking suffix when reapplyConfig adopts only the config model", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		// Both models support `xhigh`, so the assertion reads the adopted knob
		// rather than a capability clamp on the destination model.
		const overlayModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const targetSessionFile = await writeRoleModelSession(
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			"default",
		);

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });
		expect(cfgDefaultThinkingLevel.isConfigured(settings)).toBe(false);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// The model knob is adopted from config; the thinking knob config never
		// named stays the session's own, not the adopted model's default.
		expect(result.session.model?.id).toBe(overlayModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);
	});

	describe("CLI --reapply-config startup scope", () => {
		const bakedSelector = "anthropic/claude-sonnet-4-5";
		const configYaml = `modelRoles:\n  default: ${bakedSelector}\ndefaultThinkingLevel: ${Effort.XHigh}\n`;

		/** A registry whose baked model carries its own `thinking.defaultLevel`. */
		async function createDefaultLevelRegistry(): Promise<ModelRegistry> {
			const baseline = getAnthropicModelOrThrow("claude-sonnet-4-5");
			if (!baseline.thinking) throw new Error("Expected claude-sonnet-4-5 to support thinking");
			const modelsPath = path.join(tempDir.path(), `models-default-level-${Bun.nanoseconds()}.yml`);
			await Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						anthropic: {
							modelOverrides: {
								[baseline.id]: { thinking: { ...baseline.thinking, defaultLevel: Effort.Low } },
							},
						},
					},
				}),
			);
			const registry = new ModelRegistry(sharedAuthStorage, modelsPath);
			expect(registry.find("anthropic", baseline.id)?.thinking?.defaultLevel).toBe(Effort.Low);
			return registry;
		}

		async function startFromCli(
			argv: string[],
			sessionManager: SessionManager,
			modelRegistry: ModelRegistry,
			settings: Settings,
			scopedModels: ScopedModel[] = [],
		): Promise<AgentSession> {
			const options = await buildSessionOptions(
				parseArgs(["--cwd", tempDir.path(), ...argv]),
				scopedModels,
				sessionManager,
				modelRegistry,
				settings,
			);
			const result = await createAgentSession({
				...options,
				agentDir: tempDir.path(),
				authStorage: sharedAuthStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			session = result.session;
			return result.session;
		}

		async function forkBakedSession(): Promise<SessionManager> {
			const sourceFile = await writeThinkingModelSession(bakedSelector, Effort.Medium);
			return SessionManager.forkFrom(sourceFile, tempDir.path(), path.join(tempDir.path(), "forked"));
		}

		it("keeps fresh-session thinking precedence when --reapply-config is passed", async () => {
			const modelRegistry = await createDefaultLevelRegistry();
			const settings = await loadOverlaySettingsRaw(configYaml);

			const started = await startFromCli(
				["--reapply-config"],
				SessionManager.inMemory(tempDir.path()),
				modelRegistry,
				settings,
			);

			// Fresh precedence: the model's own default outranks `defaultThinkingLevel`.
			expect(started.model?.id).toBe("claude-sonnet-4-5");
			expect(started.configuredThinkingLevel()).toBe(Effort.Low);
		});

		it("keeps fresh-session thinking precedence for a direct SDK reapplyConfig", async () => {
			const modelRegistry = await createDefaultLevelRegistry();
			const settings = await loadOverlaySettingsRaw(configYaml);

			const result = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage: sharedAuthStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				reapplyConfig: true,
			});
			session = result.session;

			expect(result.session.model?.id).toBe("claude-sonnet-4-5");
			expect(result.session.configuredThinkingLevel()).toBe(Effort.Low);
		});

		it("adopts config thinking on a scoped --fork without a user --model", async () => {
			const modelRegistry = await createDefaultLevelRegistry();
			const settings = await loadOverlaySettingsRaw(configYaml);
			const scopedModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!scopedModel) throw new Error("Expected the scoped model in the registry");

			const started = await startFromCli(
				["--fork", "parent", "--models", bakedSelector, "--reapply-config"],
				await forkBakedSession(),
				modelRegistry,
				settings,
				[{ model: scopedModel, explicitThinkingLevel: false }],
			);

			// The scope's own pick is not a user `--model`, so the thinking knob reapplies.
			expect(started.model?.id).toBe("claude-sonnet-4-5");
			expect(started.configuredThinkingLevel()).toBe(Effort.XHigh);
		});

		it("keeps the forked thinking level when the user pins --model", async () => {
			const modelRegistry = await createDefaultLevelRegistry();
			const settings = await loadOverlaySettingsRaw(configYaml);

			const started = await startFromCli(
				["--fork", "parent", "--model", bakedSelector, "--reapply-config"],
				await forkBakedSession(),
				modelRegistry,
				settings,
			);

			expect(started.model?.id).toBe("claude-sonnet-4-5");
			expect(started.configuredThinkingLevel()).toBe(Effort.Medium);
		});
	});

	it("adopts the config thinking level over a saved selector suffix when config names both knobs", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const overlayModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const targetSessionFile = await writeRoleModelSession(
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			"default",
		);

		// Config names the thinking knob, so it outranks the saved suffix — the
		// suffix must be a fallback for an unnamed knob, never a floor under a
		// named one.
		const settings = await loadOverlaySettings({ default: `${modelValue(overlayModel)}:${Effort.Low}` });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(overlayModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Low);
	});

	// A `thinking_level_change` entry is the session's explicit thinking choice
	// and outranks the selector suffix, exactly as on a bare resume.
	it("prefers a thinking entry over a saved selector suffix under reapplyConfig", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const overlayModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const targetSessionFile = await writeThinkingModelSession(
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			Effort.Low,
		);

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(overlayModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Low);
	});

	// Explicit --model pins identity only. Without a configured thinking knob, the
	// saved suffix remains the session's choice; the pinned model default would
	// silently change it.
	it("keeps a saved selector's thinking suffix when reapplyConfig is combined with an explicit model", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const explicitModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const targetSessionFile = await writeRoleModelSession(
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			`${modelValue(bakedModel)}:${Effort.XHigh}`,
			"default",
		);

		const settings = await loadOverlaySettings({ default: modelValue(explicitModel) });
		expect(cfgDefaultThinkingLevel.isConfigured(settings)).toBe(false);

		const result = await createStartupResumeSession(targetSessionFile, settings, {
			reapplyConfig: true,
			model: explicitModel,
		});

		expect(result.session.model?.id).toBe(explicitModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.XHigh);
	});

	it("lets explicit thinking and service-tier flags override reapply config", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const thinkingFile = await writeThinkingModelSession(modelValue(model), Effort.Medium);
		const tierFile = await writeServiceTierSession(modelValue(model), "priority");
		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ndefaultThinkingLevel: ${Effort.XHigh}\ntier:\n  openai: flex\n  google: priority\n`,
		);

		const thinkingResult = await createStartupResumeSession(thinkingFile, settings, {
			reapplyConfig: true,
			thinkingLevel: Effort.Low,
		});
		expect(thinkingResult.session.configuredThinkingLevel()).toBe(Effort.Low);

		const tierResult = await createStartupResumeSession(tierFile, settings, {
			reapplyConfig: true,
			openAIServiceTier: "default",
		});
		expect(tierResult.session.serviceTierByFamily.openai).toBe("default");
		expect(tierResult.session.serviceTierByFamily.google).toBe("priority");
	});

	it("adopts the config service tier over the baked session tier for the same family with reapplyConfig", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeServiceTierSession(modelValue(model), "priority");

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  openai: flex\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.serviceTierByFamily.openai).toBe("flex");
	});

	it("merges config service tier per family, keeping baked families the config omits", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		// Session baked an openai tier; config specifies only google.
		const targetSessionFile = await writeServiceTierSession(modelValue(model), "priority");

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  google: flex\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// The config's google tier is adopted; the session's openai tier is kept.
		expect(result.session.serviceTierByFamily.google).toBe("flex");
		expect(result.session.serviceTierByFamily.openai).toBe("priority");
	});

	// tier.<family>: none is configured, but serviceTierSettingToTier maps it to
	// undefined and the config map omits it. isConfigured distinguishes it from omission.
	it("clears the baked session tier when the config explicitly configures that family to none", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeServiceTierSession(modelValue(model), "priority");

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  openai: none\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// Explicit `none` disables the family; the baked `priority` must not survive.
		expect(result.session.serviceTierByFamily.openai).toBeUndefined();
	});

	it("keeps a baked family the config never names, even while another family is explicitly none", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeServiceTierSession(modelValue(model), "priority");

		// `google: none` is configured; `openai` is not named at all.
		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  google: none\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// Only the explicitly-configured family is cleared; the unnamed one is kept.
		expect(result.session.serviceTierByFamily.openai).toBe("priority");
	});

	it("restores the baked session service tier on a bare resume without reapplyConfig", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeServiceTierSession(modelValue(model), "priority");

		const settings = await loadOverlaySettings({ default: modelValue(model) });

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.serviceTierByFamily.openai).toBe("priority");
	});

	it("lets a default-off fresh session adopt a tier configured before its resume", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const freshSettings = await loadOverlaySettings({ default: modelValue(model) });
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "fresh-tier"));
		const fresh = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings: freshSettings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = fresh.session;
		expect(sessionManager.getBranch().some(entry => entry.type === "service_tier_change")).toBe(false);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fresh session file");
		await fresh.session.dispose();
		session = undefined;

		const resumed = await createStartupResumeSession(
			sessionFile,
			await loadOverlaySettingsRaw(`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  openai: priority\n`),
		);

		expect(resumed.session.serviceTierByFamily.openai).toBe("priority");
	});

	it("restores a recorded empty tier instead of adopting later config on bare resume", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeServiceTierSession(modelValue(model), null);

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  openai: priority\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.serviceTierByFamily.openai).toBeUndefined();
	});

	it("adopts configured tier on bare resume of a legacy session without a tier entry", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(model), modelValue(model), "default");

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  openai: priority\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.serviceTierByFamily.openai).toBe("priority");
	});

	it("still adopts that later tier when reapplyConfig is supplied", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(model), modelValue(model), "default");

		const settings = await loadOverlaySettingsRaw(
			`modelRoles:\n  default: ${modelValue(model)}\ntier:\n  openai: priority\n`,
		);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.serviceTierByFamily.openai).toBe("priority");
	});

	it("does not persist the adopted config values back as session entries on a reapplyConfig resume", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const overlayModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(overlayModel.id);
		// Adopted values are per-run intent, not written back — the branch still
		// holds only the two fixture model_change entries (both the baked model),
		// and the adopted overlay model is never appended, so a later bare resume
		// still restores the session's own baked model.
		const modelChanges = result.session.sessionManager.getBranch().filter(entry => entry.type === "model_change");
		expect(modelChanges.map(entry => entry.model)).toEqual([modelValue(bakedModel), modelValue(bakedModel)]);
		expect(modelChanges.some(entry => entry.model === modelValue(overlayModel))).toBe(false);
		expect(result.session.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change")).toBe(
			false,
		);
	});

	it("reports the model swap when reapplyConfig adopts a different config default", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const overlayModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(overlayModel.id);
		// The swap is otherwise silent, so reapplyConfig surfaces a notice naming
		// both the adopted model and the session's own. Assert the SWAP branch, not
		// just the operands: the broken-config branch also names both models, so a
		// `.toContain` on the ids alone would pass on an inverted discrimination.
		expect(result.modelFallbackMessage).toContain("resumed on");
		expect(result.modelFallbackMessage).not.toContain("did not resolve");
		expect(result.modelFallbackMessage).toContain(modelValue(overlayModel));
		expect(result.modelFallbackMessage).toContain(modelValue(bakedModel));
	});

	it("stays silent when reapplyConfig adopts the same model the session already ran", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(model), modelValue(model), "default");

		const settings = await loadOverlaySettings({ default: modelValue(model) });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(model.id);
		// No swap happened, so there is nothing to report.
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("reports the broken config default when reapplyConfig falls back to the session model", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

		const settings = await loadOverlaySettings({ default: "anthropic/no-such-model-xyz:xhigh" });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(bakedModel.id);
		// A broken config default would otherwise be an indistinguishable no-op;
		// the notice names the unresolved default and that the session was kept.
		// Pin arm (a): the double-failure arm (c) also opens "did not resolve", so
		// assert the substrings unique to the fallback branch.
		expect(result.modelFallbackMessage).toContain("did not resolve");
		expect(result.modelFallbackMessage).toContain("anthropic/no-such-model-xyz");
		expect(result.modelFallbackMessage).toContain("kept the session's");
		expect(result.modelFallbackMessage).not.toContain("could not be restored");
	});

	it("keeps the baked session model when reapplyConfig names a tombstoned default", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		// A tombstoned `modelRoles.default: null` is not a config-named default, so
		// the model knob is not adopted and the session model is retained.
		const settings = await loadOverlaySettings({ default: null });
		expect(settings.getModelRole("default")).toBeUndefined();

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("keeps the baked session model and thinking when reapplyConfig names an empty default", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeThinkingModelSession(modelValue(bakedModel), Effort.Medium);

		// An explicit empty-string default resolves to no model — the resolver's
		// own "no default" case, so the model knob is not adopted and the resume
		// keeps its own baked values with no bogus "did not resolve" notice.
		const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: ""\n`);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("keeps the baked session model when reapplyConfig names the bare default sentinel", async () => {
		const bakedModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(bakedModel), modelValue(bakedModel), "default");

		// A literal `default` is the resolver's self-referential sentinel, not a
		// config-named model, so it is treated as "no default": session retained,
		// no notice.
		const settings = await loadOverlaySettingsRaw(`modelRoles:\n  default: default\n`);

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		expect(result.session.model?.id).toBe(bakedModel.id);
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("reports the double failure when neither the config default nor the baked session model resolves", async () => {
		// Session baked on an unresolvable model AND overlay names an unresolvable
		// default: the model comes from an arbitrary availability pick, which must
		// never be silent — the same case the bare-resume path warns about.
		const targetSessionFile = await writeRoleModelSession(
			"anthropic/no-such-baked-model-abc",
			"anthropic/no-such-baked-model-abc",
			"default",
		);

		const settings = await loadOverlaySettings({ default: "anthropic/no-such-model-xyz" });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// A model was picked (some authed default), and the notice names both the
		// unresolved config default and the unrestorable session model.
		expect(result.session.model).toBeDefined();
		expect(result.modelFallbackMessage).toContain("did not resolve");
		expect(result.modelFallbackMessage).toContain("anthropic/no-such-model-xyz");
		expect(result.modelFallbackMessage).toContain("anthropic/no-such-baked-model-abc");
		expect(result.modelFallbackMessage).toContain("could not be restored");
	});

	it("stays silent under reapplyConfig when the session has no baked model to swap from", async () => {
		// A session with entries but no `model_change` (so no baked model to
		// restore or compare against). `reapplyConfig` must not leak a notice
		// naming a nonexistent session model — a fresh/no-model resume is a no-op.
		const overlayModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const targetSessionFile = path.join(tempDir.path(), `target-nomodel-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp,
					message: { role: "user", content: "hi" },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const settings = await loadOverlaySettings({ default: modelValue(overlayModel) });

		const result = await createStartupResumeSession(targetSessionFile, settings, { reapplyConfig: true });

		// No baked model existed, so nothing was swapped away from; the notice must
		// not fire (and must never interpolate a bare `undefined`).
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("switches the active model without persisting by default", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
		});
		let modelChangedCount = 0;
		created.session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});

		await created.session.setModel(nextModel);

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(modelChangedCount).toBe(1);

		await created.session.setModel(nextModel);
		expect(modelChangedCount).toBe(1);
	});

	it("persists the default role when explicitly requested", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		await created.session.setModel(nextModel, "default", { persist: true });

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("switches the active model even when the live context is over the target window", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		const targetWindow = nextModel.contextWindow ?? 0;
		expect(targetWindow).toBeGreaterThan(0);

		const result = await created.session.setModel(nextModel, "default", { persist: true });

		expect(result).toEqual({ switched: true });
		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("cycles role models without rewriting configured roles", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = `${modelValue(slowModel)}:high`;

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const result = await created.session.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slowModel.id);
		expect(created.session.model?.id).toBe(slowModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles role models backward from the current role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = modelValue(slowModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const forward = await created.session.cycleRoleModels(["default", "slow"], "forward");
		const backward = await created.session.cycleRoleModels(["default", "slow"], "backward");

		expect(forward?.role).toBe("slow");
		expect(backward?.role).toBe("default");
		expect(created.session.model?.id).toBe(defaultModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles available models without persisting the default role", async () => {
		const created = await createSession({
			selectInitialModel: availableModels => {
				if (availableModels.length <= 1 || !availableModels[0]) {
					throw new Error("Expected at least two available models");
				}
				return availableModels[0];
			},
		});
		const initialModel = created.session.model;
		if (!initialModel) throw new Error("Expected initial model to be set");
		const defaultRoleValue = modelValue(initialModel);
		created.settings.setModelRole("default", defaultRoleValue);

		const result = await created.session.cycleModel();

		if (!result) throw new Error("Expected cycleModel to return a new model");
		expect(modelValue(result.model)).not.toBe(defaultRoleValue);
		const activeModel = created.session.model;
		if (!activeModel) throw new Error("Expected active model after cycleModel");
		expect(modelValue(activeModel)).toBe(modelValue(result.model));
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
	});

	it("restores the last active role model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);

		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue, smol: smolRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(smolModel.id);
	});

	it("restores configured tiers when switching to a legacy session without a tier entry", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(modelValue(model), modelValue(model), "default");

		const created = await createSession({
			initialModel: model,
			modelRoles: { default: modelValue(model) },
			persist: true,
		});
		cfgTierOpenai.override(created.settings, "priority");

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);

		expect(created.session.serviceTierByFamily.openai).toBe("priority");
	});

	it("does not enable a config tier when switching to a session that recorded none", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeServiceTierSession(modelValue(model), null);

		const created = await createSession({
			initialModel: model,
			modelRoles: { default: modelValue(model) },
			persist: true,
		});
		// A paid tier configured AFTER that session existed.
		cfgTierOpenai.override(created.settings, "priority");

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);

		// Recorded absence remains empty after the later config tier is set.
		expect(created.session.serviceTierByFamily.openai).toBeUndefined();
	});

	it("restores the last active role model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const result = await createStartupResumeSession(targetSessionFile);

		expect(result.session.model?.id).toBe(smolModel.id);
	});

	it("falls back to the saved default model when switch-session role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const previousModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");

		const created = await createSession({
			initialModel: previousModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when switch-session last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);

		const created = await createSession({
			initialModel: fallbackModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("falls back to the saved default model when startup role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settingsFallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(settingsFallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when startup last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(fallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores a temporary model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(temporaryModel.id);
	});

	it("restores a temporary model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");
		const settings = Settings.isolated();
		settings.setModelRole("default", defaultRoleValue);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(temporaryModel.id);
	});

	it("activates auto thinking on startup resume when modelRoles.default carries an explicit :auto suffix", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(
			modelValue(defaultModel),
			modelValue(defaultModel),
			"default",
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", `${modelValue(defaultModel)}:auto`);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("marks an incomplete process-exit transcript aborted during SDK resume without dropping history", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted"));
		const interruptedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "state.txt" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendMessage(interruptedAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "preserved partial result" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected interrupted session file");

		const result = await createStartupResumeSession(sessionFile);
		const messages = result.session.sessionManager.buildSessionContext({ transcript: true }).messages;
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Previous OMP process exited before completing the turn.",
		});
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.content.some(part => part.type === "text" && part.text === "preserved partial result"),
			),
		).toBe(true);
		expect(messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(
			1,
		);
	});

	it("marks a first user-message process-exit tail aborted with the selected model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted-user"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(
			result.session.sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				api: defaultModel.api,
				provider: defaultModel.provider,
				model: defaultModel.id,
				stopReason: "aborted",
			},
		});
	});

	it("marks an interrupted first turn aborted when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const created = await createSession({ initialModel: defaultModel, persist: true });
		const targetFile = path.join(tempDir.path(), "switch-interrupted-user.jsonl");
		const timestamp = "2026-07-11T02:20:08.800Z";
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "switch-target", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: modelValue(defaultModel),
				},
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "inspect state", timestamp: Date.parse(timestamp) },
				},
				{
					type: "custom",
					id: "exit",
					parentId: "user",
					timestamp,
					customType: "session_exit",
					data: { reason: "exit", kind: "process_exit", recordedAt: timestamp },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		await expect(created.session.switchSession(targetFile)).resolves.toBe(true);

		expect(created.session.sessionManager.buildSessionContext({ transcript: true }).messages.at(-1)).toMatchObject({
			role: "assistant",
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
			stopReason: "aborted",
		});
	});

	it("lists restorable temporary model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					temporary: "anthropic/claude-sonnet-4-6",
				},
				"temporary",
			),
		).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
	});

	it("lists only the default model for ephemeral fallback restores", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					[EPHEMERAL_MODEL_CHANGE_ROLE]: "anthropic/claude-sonnet-4-6",
				},
				EPHEMERAL_MODEL_CHANGE_ROLE,
			),
		).toEqual(["anthropic/claude-sonnet-4-5"]);
	});
});
