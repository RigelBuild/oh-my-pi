/** Configured model-role candidates get cold discovery before session or arbitrary fallbacks. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const DISCOVERED_MODEL = "phi3";

let discoveryFetches = 0;
/** Provider ids passed to scoped `refreshDiscoverableProviders` calls. */
let refreshedProviders: string[] = [];

describe("--reapply-config cold-discovery configured default", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let observed: { fallbackSawJoin: boolean | undefined } | undefined;
	let fallbackMessage: string | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-cold-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		discoveryFetches = 0;
		refreshedProviders = [];
		tempDir = TempDir.createSync("@omp-reapply-cold-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		fallbackMessage = undefined;
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

	const mockOllamaDiscovery: FetchImpl = async input => {
		const url = String(input);
		if (url === `${OLLAMA_ENDPOINT}/api/tags`) {
			discoveryFetches++;
			return Response.json({ models: [{ name: DISCOVERED_MODEL }] });
		}
		if (url === `${OLLAMA_ENDPOINT}/api/show`) {
			return Response.json({ capabilities: ["completion"] });
		}
		throw new Error(`Unexpected URL: ${url}`);
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

	async function loadOverlay(defaultRole: string, enabledModels?: readonly string[]): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-${Bun.nanoseconds()}.yml`);
		const overlay = {
			modelRoles: { default: defaultRole },
			...(enabledModels ? { enabledModels: [{ path: tempDir.path(), models: enabledModels }] } : {}),
		};
		await Bun.write(overlayPath, JSON.stringify(overlay));
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function loadOverlayRoles(roles: Record<string, string>): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-${Bun.nanoseconds()}.yml`);
		const body = Object.entries(roles)
			.map(([role, value]) => `  ${role}: "${value}"`)
			.join("\n");
		await Bun.write(overlayPath, `modelRoles:\n${body}\n`);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	/** Resume against an ollama catalog that is empty until discovery fetches it. */
	async function resume(
		sessionFile: string,
		settings: Settings,
		extraProviders: Record<string, unknown> = {},
		authOverride: AuthStorage = authStorage,
		// A no-UI resume fails closed on an unrestorable session model; opt into the TUI fallback.
		allowSessionModelFallback = false,
	): Promise<AgentSession> {
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: `${OLLAMA_ENDPOINT}/v1`,
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
					...extraProviders,
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authOverride, modelsPath, { fetch: mockOllamaDiscovery });
		observed = observeRefreshOrder(modelRegistry);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: authOverride,
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
			...(allowSessionModelFallback ? { hasUI: true, allowSessionModelFallback: true } : {}),
		});
		session = result.session;
		fallbackMessage = result.modelFallbackMessage;
		return result.session;
	}

	/** Records whether the cold fallback joined startup discovery before refreshing. */
	function observeRefreshOrder(registry: ModelRegistry): { fallbackSawJoin: boolean | undefined } {
		const state: { fallbackSawJoin: boolean | undefined } = { fallbackSawJoin: undefined };
		let joined = false;
		const realAwait = registry.awaitBackgroundRefresh.bind(registry);
		const realRefresh = registry.refresh.bind(registry);
		spyOn(registry, "awaitBackgroundRefresh").mockImplementation(async () => {
			await realAwait();
			joined = true;
		});
		spyOn(registry, "refresh").mockImplementation(async strategy => {
			state.fallbackSawJoin ??= joined;
			return await realRefresh(strategy);
		});
		const realScopedRefresh = registry.refreshDiscoverableProviders.bind(registry);
		spyOn(registry, "refreshDiscoverableProviders").mockImplementation(async (providerIds, strategy) => {
			const ids = [...providerIds];
			refreshedProviders.push(...ids);
			return await realScopedRefresh(ids, strategy);
		});
		return state;
	}

	it("skips the discovery retry when no unresolved candidate could become available", async () => {
		// The first candidate belongs to a static-only provider; ollama discovery
		// cannot resolve it, so this case must not trigger a refresh.
		const later = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(later));

		const settings = await loadOverlay(`static-only/missing,${modelValue(later)}`);
		const resumed = await resume(sessionFile, settings, {
			"static-only": {
				baseUrl: "https://static.example.invalid/v1",
				api: "openai-completions",
				auth: "none",
				models: [{ id: "present", name: "Present" }],
			},
		});

		expect(resumed.model?.id).toBe(later.id);
		// The fallback must not run its own `refresh`.
		expect(observed?.fallbackSawJoin).toBeUndefined();
	});

	it("discovers the configured default instead of falling back to the session's baked model", async () => {
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// The only configured candidate needs discovery; the session's own model
		// is bundled and immediately restorable, so it wins any race it is
		// allowed to enter.
		const settings = await loadOverlay(`ollama/${DISCOVERED_MODEL}`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
		// The cold-cache fallback must join the startup background refresh before
		// launching its own, or both fetch the same catalog at once.
		expect(observed?.fallbackSawJoin).toBe(true);
	});

	it("discovers the first configured candidate instead of keeping the later one it matched early", async () => {
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// Ordered list whose first candidate needs discovery and whose second is
		// already available: the early pass adopts index 1, which leaves `model`
		// non-null and would otherwise skip the retry entirely.
		const settings = await loadOverlay(`ollama/${DISCOVERED_MODEL},${modelValue(laterCandidate)}`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
	});

	it("expands a legacy role alias before filtering discovery, so a cold role model still discovers", async () => {
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// `pi/slow` is a legacy alias to cold ollama. Treating `pi` as the provider
		// skips discovery needed to resolve that higher-priority model.
		const settings = await loadOverlayRoles({
			default: `pi/slow,${modelValue(laterCandidate)}`,
			slow: `ollama/${DISCOVERED_MODEL}`,
		});

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
	});

	it("discovers a cold FIRST link of the matched alias's own chain, not the later link it matched", async () => {
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// `@slow` expands to cold ollama followed by a static model. Since the
		// static pass matches the second link at raw index 0, discovery must scan
		// expanded links through the match to find the earlier candidate.
		const settings = await loadOverlayRoles({
			default: "@slow",
			slow: `ollama/${DISCOVERED_MODEL},${modelValue(laterCandidate)}`,
		});

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
	});

	it("discovers a cold provider's only model when no default role is configured", async () => {
		// With no default role, reapply adopts nothing and this is a plain restore of
		// an unauthenticated saved model, which only a UI session may replace. The
		// only authenticated provider has no static models, so discovery remains
		// necessary for this arbitrary fallback.
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// A fresh auth store with NO anthropic key: nothing static is authenticated,
		// so no already-available model can shadow the discovery fallback. ollama is
		// keyless (`auth: "none"`), so it needs no stored credential.
		const noAuthDir = TempDir.createSync("@omp-reapply-cold-noauth-");
		const noAuth = await AuthStorage.create(path.join(noAuthDir.path(), "auth.db"));
		try {
			const settings = await Settings.loadIsolated({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				inMemory: true,
				configFiles: [],
			});

			const resumed = await resume(sessionFile, settings, {}, noAuth, true);

			expect(resumed.model?.provider).toBe("ollama");
			expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
		} finally {
			noAuth.close();
			noAuthDir.removeSync();
		}
	});

	it("skips a saved model excluded by the path-scoped enabledModels list", async () => {
		const forbiddenModel = anthropicModel("claude-opus-4-1");
		const allowedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(forbiddenModel));
		const settings = await loadOverlay("static-only/not-discovered", [modelValue(allowedModel)]);

		const resumed = await resume(
			sessionFile,
			settings,
			{
				"static-only": {
					baseUrl: "https://static.example.invalid/v1",
					api: "openai-completions",
					auth: "none",
					models: [{ id: "present", name: "Present" }],
				},
			},
			authStorage,
			true,
		);

		expect(resumed.model?.provider).toBe(allowedModel.provider);
		expect(fallbackMessage).toContain(`${modelValue(forbiddenModel)} could not be restored`);
		// The catalog already holds the excluded model, so discovery cannot help
		// and the saved-model retry must not refresh its provider.
		expect(refreshedProviders).not.toContain(forbiddenModel.provider);
	});

	it("restores a saved model from cold discovery when the configured default is unresolved", async () => {
		const sessionFile = await writeBakedSession(`ollama/${DISCOVERED_MODEL}`);
		const settings = await loadOverlay("static-only/not-discovered", [`ollama/${DISCOVERED_MODEL}`]);

		const resumed = await resume(sessionFile, settings, {
			"static-only": {
				baseUrl: "https://static.example.invalid/v1",
				api: "openai-completions",
				auth: "none",
				models: [{ id: "present", name: "Present" }],
			},
		});

		expect(discoveryFetches).toBeGreaterThan(0);
		expect(resumed.model?.provider).toBe("ollama");
		expect(resumed.model?.id).toBe(DISCOVERED_MODEL);
		expect(fallbackMessage).toContain("kept the session's");
	});
});
