/** Reapplying config preserves the configured default candidate order. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const EXTENSION_PROVIDER = "reapply-order-gw";
const EXTENSION_MODEL = "reapply-order-model";
const DYNAMIC_PROVIDER = "reapply-order-dynamic";
const DYNAMIC_MODEL = "reapply-order-dynamic-model";

describe("--reapply-config configured default fallback order", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-order-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-reapply-order-");
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

	/**
	 * Registers a provider the same way a real extension does — through the
	 * runtime's pending-registration queue, which `sdk.ts` drains only AFTER its
	 * early role resolution.
	 */
	const registerLateProvider: ExtensionFactory = pi => {
		pi.registerProvider(EXTENSION_PROVIDER, {
			baseUrl: "https://reapply-order.example.invalid/v1",
			apiKey: "literal-test-key",
			api: "openai-completions",
			models: [
				{
					id: EXTENSION_MODEL,
					name: "Reapply Order Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
		});
	};

	/** A dynamic-only provider: its model exists only after a discovery pass. */
	const registerDynamicProvider: ExtensionFactory = pi => {
		pi.registerProvider(DYNAMIC_PROVIDER, {
			baseUrl: "https://reapply-order-dynamic.example.invalid/v1",
			apiKey: "literal-test-key",
			api: "openai-completions",
			fetchDynamicModels: async () => [
				{
					id: DYNAMIC_MODEL,
					name: "Reapply Order Dynamic Model",
					reasoning: true,
					thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
		});
	};

	async function writeBakedSession(bakedModelValue: string): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `baked-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: bakedModelValue,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	/**
	 * A session whose ACTIVE model is unavailable while its `default` role model
	 * still resolves, so the restore walk lands past index 0.
	 *
	 * `getRestorableSessionModels` returns two entries only when the LAST
	 * `model_change` names a non-default role: the active role model first, the
	 * default second. A trailing `default` change collapses the list to one.
	 */
	async function writeTwoModelSession(earlierValue: string, activeValue: string): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `two-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "two-model-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "earlier-model",
					parentId: null,
					timestamp,
					model: earlierValue,
					role: "default",
				},
				{
					type: "model_change",
					id: "active-model",
					parentId: "earlier-model",
					timestamp,
					model: activeValue,
					role: "task",
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

	async function resume(sessionFile: string, settings: Settings, reapplyConfig: boolean): Promise<AgentSession> {
		return (await resumeResult(sessionFile, settings, reapplyConfig)).session;
	}

	/** Same resume, but keeping the result so `modelFallbackMessage` is readable. */
	async function resumeResult(
		sessionFile: string,
		settings: Settings,
		reapplyConfig: boolean,
		extensions: ExtensionFactory[] = [registerLateProvider],
	): Promise<{ session: AgentSession; modelFallbackMessage?: string }> {
		// A registry private to this resume: the extension provider registration
		// must not leak into any other test's catalog.
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			extensions,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			reapplyConfig,
		});
		session = result.session;
		return result;
	}

	it("resumes on the first configured candidate once its extension provider registers", async () => {
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// Ordered fallback list: the FIRST candidate is behind the extension
		// provider (invisible at early resolution), the second is bundled and
		// already available, so the early pass matches index 1.
		const settings = await loadOverlay(`${EXTENSION_PROVIDER}/${EXTENSION_MODEL},${modelValue(laterCandidate)}`);

		const resumed = await resume(sessionFile, settings, true);

		// The preferred candidate became available during extension registration,
		// so `--reapply-config` must land on it — never on the configured fallback.
		expect(resumed.model?.provider).toBe(EXTENSION_PROVIDER);
		expect(resumed.model?.id).toBe(EXTENSION_MODEL);
	});

	it("still resumes on the first configured candidate when it is already available", async () => {
		// Guards the re-resolution against regressing the ordinary case: when the
		// early pass already matched index 0 there is nothing to re-resolve, and
		// the adopted model must stay put.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const firstCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${modelValue(firstCandidate)},${EXTENSION_PROVIDER}/${EXTENSION_MODEL}`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.provider).toBe(firstCandidate.provider);
		expect(resumed.model?.id).toBe(firstCandidate.id);
	});

	it("retains the session model when every fallback candidate is a self alias", async () => {
		// A list of only self aliases is not a configured default; keep the session model.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("*,@default");

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.provider).toBe(bakedModel.provider);
		expect(resumed.model?.id).toBe(bakedModel.id);
	});

	it("still adopts a list that mixes a self alias with a real candidate", async () => {
		// One real pattern makes the list a configured default. The alias sits last
		// because a leading `*` stalls the role resolver on its own circularity.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const realCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${modelValue(realCandidate)},*`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.provider).toBe(realCandidate.provider);
		expect(resumed.model?.id).toBe(realCandidate.id);
	});

	it("adopts a self-alias-only list that still resolved to a model", async () => {
		// Classify by resolution, not spelling: `default,@default` resolves to the
		// bundled `cursor/default` once Cursor credentials exist.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("default,@default");

		// Cursor credentials make the BUNDLED `cursor/default` available, which is
		// the collision the sentinel exists for. Scoped to this test.
		authStorage.keys.setRuntime("cursor", "test-cursor-key");
		try {
			const resumed = await resume(sessionFile, settings, true);
			expect(resumed.model?.provider).toBe("cursor");
			expect(resumed.model?.id).toBe("default");
		} finally {
			authStorage.keys.setRuntime("cursor", "");
		}
	});

	it("stops at a bare self alias ahead of a later suffixed one", async () => {
		// `missing/model,*,*:low`: the concrete candidate does not resolve, so the
		// BARE `*` is the fallback reached — and it names no thinking knob, so the
		// session keeps its own level. Scanning for the first pattern that carries
		// a suffix skipped it and applied `low` from a fallback never reached.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("missing/model,*,*:low");

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.configuredThinkingLevel()).not.toBe(ThinkingLevel.Low);
	});

	it("applies the suffix of a self alias reached past an unresolvable candidate", async () => {
		// `missing/model,*:low`: the concrete candidate is CONFIGURED but resolves
		// to nothing, so `*:low` is the fallback actually reached and its `low` is
		// the live knob. Gating on "was a concrete pattern configured" suppressed
		// it, leaving a fresh session on the arbitrary fallback model's default.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("missing/model,*:low");

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
	});

	it("stops at a reached self alias ahead of a later resolvable model", async () => {
		// The first reached entry is `*:low`, so keep the session model at low even
		// though a later concrete model resolves.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const later = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`missing/model,*:low,${modelValue(later)}`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.id).toBe(bakedModel.id);
		expect(resumed.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
	});

	it("restores a cold dynamic saved model under a self-alias-only default before any arbitrary pick", async () => {
		// The saved provider is refreshable but not config-discoverable, so only
		// the post-discovery fallback can restore it, and it must not require a
		// config-named default.
		const sessionFile = await writeBakedSession(`${DYNAMIC_PROVIDER}/${DYNAMIC_MODEL}`);
		const settings = await loadOverlay("*:high");

		const result = await resumeResult(sessionFile, settings, true, [registerDynamicProvider]);

		expect(result.session.model?.provider).toBe(DYNAMIC_PROVIDER);
		expect(result.session.model?.id).toBe(DYNAMIC_MODEL);
		expect(result.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("reports that the active session model failed to restore, not that it was kept", async () => {
		// Config default broken AND the session's active model (index 0) gone, but
		// an earlier saved model resolves. Treating every nonnegative restore index
		// as "kept the session's model" claimed nothing changed while the resume
		// had in fact moved off the active model.
		const earlier = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeTwoModelSession(modelValue(earlier), "anthropic/definitely-not-a-model:low");

		const settings = await loadOverlay("missing/model");

		const result = await resumeResult(sessionFile, settings, true);

		expect(result.session.model?.id).toBe(earlier.id);
		const notice = result.modelFallbackMessage ?? "";
		expect(notice).toContain("could not be restored");
		expect(notice).not.toContain("kept the session");
	});

	it("ignores a thinking suffix on a fallback that did not win", async () => {
		// `"anthropic/...,*:low"`: the concrete entry resolves, so the `low` belongs
		// to a fallback that was never selected. Scanning every pattern for a
		// suffix ran the CHOSEN model at the loser's level.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const winner = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${modelValue(winner)},*:low`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.id).toBe(winner.id);
		expect(resumed.configuredThinkingLevel()).not.toBe(ThinkingLevel.Low);
	});

	it("keeps the baked session model on a bare resume even when a later candidate matched first", async () => {
		// Without the flag the session's own model wins regardless of how the
		// configured role resolved, so the re-resolution must not reach this path.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${EXTENSION_PROVIDER}/${EXTENSION_MODEL},${modelValue(laterCandidate)}`);

		const resumed = await resume(sessionFile, settings, false);

		expect(resumed.model?.id).toBe(bakedModel.id);
	});

	it("compares the winning candidate's position in the configured pattern space", async () => {
		// Positions must use the configured pattern list, not the alias-expanded one.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const winner = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// `slow` expands to two missing candidates then the available winner, so
		// the winner sits at expanded index 2 while `@slow` is raw index 0 and the
		// trailing alias is raw index 1.
		const overlayPath = path.join(tempDir.path(), `overlay-expand-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			overlayPath,
			`modelRoles:\n  slow: "missing-a/model,missing-b/model,${modelValue(winner)}"\n  default: "@slow,*:low"\n`,
		);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});

		const resumed = await resume(sessionFile, settings, true);

		// A trailing `*:low` is not a reached candidate: adopt `@slow`'s winner
		// rather than keep the baked model at low effort.
		expect(resumed.model?.provider).toBe(winner.provider);
		expect(resumed.model?.id).toBe(winner.id);
	});
});
