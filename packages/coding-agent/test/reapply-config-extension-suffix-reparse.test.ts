/** A saved literal model suffix must not become a thinking choice. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("--reapply-config saved suffix against extension providers", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-reapply-ext-suffix-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/** An extension provider holding a model whose id itself ends in `:low`. */
	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "router:low",
					name: "Router Low",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "config-pick",
					name: "Config Pick",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	/** A resumable session whose only model entry is a suffix-shaped literal ID. */
	async function writeBakedSession(provider = "runtime-provider"): Promise<string> {
		const sessionFile = path.join(tempDir, `baked-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-suffix-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${provider}/router:low`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	test("does not transfer a literal id's trailing segment as a thinking level", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Config names the identity, so the early suffix parse runs and the
		// identity walk (which would have reparsed post-extension) is skipped.
		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The config default is adopted, and `low` — which was never a thinking
			// selection, only the tail of a model id — must not ride along onto it.
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	/** Resume `runtime-provider/router:low` with no config default or pin, so restore owns identity and level. */
	async function restoreBakedSession(extension: ExtensionFactory) {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, `startup-${Bun.nanoseconds()}`));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});
		return { session, modelRegistry };
	}

	const routedThinking = {
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
		defaultLevel: Effort.High,
		effortRouting: { [Effort.Low]: "router:low" },
	} satisfies NonNullable<Model["thinking"]>;

	test("keeps the thinking suffix of a saved selector that only aliases a wire route", async () => {
		const { session, modelRegistry } = await restoreBakedSession(pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{
						id: "router",
						name: "Router",
						reasoning: true,
						thinking: routedThinking,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		});
		try {
			// Alias-aware lookup reaches `router` through its wire route; exact membership does not.
			expect(modelRegistry.find("runtime-provider", "router:low")?.id).toBe("router");
			expect(modelRegistry.hasModelId("runtime-provider", "router:low")).toBe(false);
			expect(session.model?.id).toBe("router");
			expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	test("restores a literal suffix-shaped id intact beside its suffix-less sibling", async () => {
		const { session } = await restoreBakedSession(pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{
						id: "router",
						name: "Router",
						reasoning: true,
						thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
					{
						id: "router:low",
						name: "Router Low",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		});
		try {
			expect(session.model?.id).toBe("router:low");
			expect(session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	test("reparses a saved suffix after dynamic discovery", async () => {
		// The extension catalog supplies the saved literal ID.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let dynamicFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// No `models`: nothing is visible until the catalog is fetched.
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
						{
							id: "config-pick",
							name: "Config Pick",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-dynamic"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The catalog really was cold: something had to fetch it.
			expect(dynamicFetches).toBeGreaterThan(0);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	test("reparses a cold vLLM suffix against a reasoning config model", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `builtin-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					vllm: {
						baseUrl: "https://vllm.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						modelOverrides: {
							"config-pick": {
								reasoning: true,
								thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" },
							},
						},
					},
				},
			}),
		);
		let discoveryCount = 0;
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				if (String(input) !== "https://vllm.example.invalid/v1/models") {
					throw new Error(`Unexpected URL: ${String(input)}`);
				}
				discoveryCount++;
				return Response.json({ data: [{ id: "router:low", max_model_len: 32768 }, { id: "config-pick" }] });
			},
		});
		const settings = Settings.isolated();
		settings.setModelRole("default", "vllm/config-pick");
		const sessionFile = await writeBakedSession("vllm");
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-vllm"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			expect(discoveryCount).toBeGreaterThan(0);
			expect(modelRegistry.find("vllm", "router:low")).toBeDefined();
			expect(session.model?.id).toBe("config-pick");
			expect(session.model?.reasoning).toBe(true);
			expect(session.model?.thinking?.defaultLevel).toBe(ThinkingLevel.High);
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await session.dispose();
		}
	});

	test("does not fetch a stale built-in catalog just to read a saved suffix", async () => {
		// An expired built-in cache still lists its ids, so it can already tell a
		// literal suffix from a thinking one; startup must not wait on the network.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const baseUrl = "https://vllm.example.invalid/v1";
		const modelsPath = path.join(tempDir, `stale-builtin-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({ providers: { vllm: { baseUrl, api: "openai-completions", auth: "none" } } }),
		);
		const cached = buildModel({
			id: "config-pick",
			name: "Config Pick",
			api: "openai-completions",
			provider: "vllm",
			baseUrl,
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
		writeModelCache(
			resolveModelCacheProviderId("vllm", { baseUrl }),
			Date.now() - 3 * 24 * 60 * 60 * 1000,
			[cached],
			true,
			fingerprintStaticModels([]),
			path.join(tempDir, "models.db"),
		);
		const fetched: string[] = [];
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				fetched.push(String(input));
				throw new Error("network disabled");
			},
		});
		// The premise, measured: the expired row makes vllm due for a refresh.
		expect(modelRegistry.canRefreshProvider("vllm")).toBe(true);
		const settings = Settings.isolated();
		settings.setModelRole("default", "vllm/config-pick");
		const sessionFile = path.join(tempDir, `stale-builtin-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "stale-builtin-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "vllm/config-pick:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-stale-builtin"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			expect(fetched).toEqual([]);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	/** Reapply `defaultRole` over a session saved on `savedModel`, with no extensions. */
	async function reapplyOverSaved(
		modelRegistry: ModelRegistry,
		authStorage: AuthStorage,
		defaultRole: string,
		savedModel: string,
	) {
		const settings = Settings.isolated();
		settings.setModelRole("default", defaultRole);
		const sessionFile = path.join(tempDir, `saved-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: "saved-session", timestamp, cwd: tempDir },
			{ type: "model_change", id: "m", parentId: null, timestamp, model: savedModel, role: "default" },
		];
		await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, `startup-${Bun.nanoseconds()}`));
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});
		return session;
	}

	test("does not block on cached ids awaiting a shared-catalog migration refresh", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("google", "google-test-key");
		const modelsPath = path.join(tempDir, `cached-google-${Bun.nanoseconds()}.yml`);
		const cached = getBundledModels("google");
		const preMigrationFingerprint = fingerprintStaticModels(cached);
		writeModelCache("google", Date.now(), cached, true, preMigrationFingerprint, path.join(tempDir, "models.db"));
		const fetched: string[] = [];
		const networkStarted = Promise.withResolvers<void>();
		const networkGate = Promise.withResolvers<void>();
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				fetched.push(String(input));
				networkStarted.resolve();
				await networkGate.promise;
				throw new Error("network held");
			},
		});

		const providerModels = modelRegistry.getProviderModels("google");
		expect(providerModels.some(model => model.id === "gemini-3.7-flash")).toBe(true);
		expect(modelRegistry.canRefreshProvider("google")).toBe(true);
		expect(modelRegistry.getProviderDiscoveryState("google")).toMatchObject({
			status: "idle",
			source: "bundled",
			stale: false,
		});
		expect(modelRegistry.getProviderDiscoveryState("google")?.models).toContain("gemini-3.7-flash");

		const created = reapplyOverSaved(
			modelRegistry,
			authStorage,
			"google/gemini-3.7-flash",
			"google/gemini-3.7-flash:low",
		);
		let session: Awaited<typeof created> | undefined;
		try {
			const startupResult = await Promise.race([
				created.then(() => "startup"),
				networkStarted.promise.then(() => "network"),
			]);
			expect(startupResult).toBe("startup");
			session = await created;
			expect(fetched).toEqual([]);
			expect(session.model?.id).toBe("gemini-3.7-flash");
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			networkGate.resolve();
			if (session) await session.dispose();
			else
				await created.then(
					createdSession => createdSession.dispose(),
					() => {},
				);
		}
	}, 30000);

	test("does not fetch a stale models.yml discovery catalog just to read a saved suffix", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const baseUrl = "http://gateway.example.invalid";
		const modelsPath = path.join(tempDir, `stale-config-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: { baseUrl, api: "openai-completions", auth: "none", discovery: { type: "openai-models-list" } },
				},
			}),
		);
		const cached = buildModel({
			id: "config-pick",
			name: "Config Pick",
			api: "openai-completions",
			provider: "gateway",
			baseUrl,
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
		writeModelCache(
			"gateway:openai-models-list-context-v3",
			Date.now() - 3 * 24 * 60 * 60 * 1000,
			[cached],
			true,
			fingerprintStaticModels([]),
			path.join(tempDir, "models.db"),
		);
		const fetched: string[] = [];
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				fetched.push(String(input));
				throw new Error("network disabled");
			},
		});
		// The premise, measured: the stale row makes the gateway due for a refresh.
		expect(modelRegistry.canRefreshProvider("gateway")).toBe(true);

		const session = await reapplyOverSaved(
			modelRegistry,
			authStorage,
			"gateway/config-pick",
			"gateway/config-pick:low",
		);
		try {
			expect(fetched).toEqual([]);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	test("refreshes a cold credential-scoped built-in to keep a literal suffixed id", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("opencode-go", "go-test-key");
		const listed: string[] = [];
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			fetch: async input => {
				const url = String(input);
				if (url !== "https://opencode.ai/zen/go/v1/models") return new Response("", { status: 404 });
				listed.push(url);
				return Response.json({ data: [{ id: "router:low" }, { id: "deepseek-v4-flash" }] });
			},
		});

		const session = await reapplyOverSaved(
			modelRegistry,
			authStorage,
			"opencode-go/deepseek-v4-flash",
			"opencode-go/router:low",
		);
		try {
			// Hydration found no cached ids, so only the suffix refresh can list the catalog.
			expect(listed.length).toBeGreaterThan(0);
			expect(modelRegistry.hasModelId("opencode-go", "router:low")).toBe(true);
			expect(session.model?.id).toBe("deepseek-v4-flash");
			expect(session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	test("marks a static-only provider as non-refreshable", () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `static-models-${Bun.nanoseconds()}.yml`);
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "base", name: "Base" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		expect(modelRegistry.hasProvider("custom")).toBe(true);
		expect(modelRegistry.canRefreshProvider("custom")).toBe(false);
	});

	test("resolves a late provider after a self-alias on a fresh session with reapply disabled", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// An authenticated bundled provider makes the arbitrary fallback pick differ.
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "fresh-self-alias-models.yml"));
		expect(modelRegistry.getAvailable().some(model => model.provider === "anthropic")).toBe(true);
		const lateDefaultProvider: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{
						id: "default",
						name: "Late Default",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};
		const settings = Settings.isolated();
		settings.setModelRole("default", "@default,runtime-provider/default");
		const sessionManager = SessionManager.inMemory(tempDir);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [lateDefaultProvider],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: false,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("default");
		} finally {
			await session.dispose();
		}
	});

	test("does not block startup on a cold catalog a persisted thinking entry outranks", async () => {
		// The suffix reparse updates restoredSessionThinkingLevel, but a persisted
		// thinking entry outranks it in pickInitialThinkingLevel. Waiting on the cold
		// provider delays startup without changing the selected level; discovery
		// continues in the background.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Held open for the whole of session creation, so "startup waited" and
		// "startup did not" are distinguishable without timing.
		const catalogGate = Promise.withResolvers<void>();
		let catalogReleased = false;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// The config model is STATIC, so resolving it needs no catalog: the
				// held-open fetch below is reached only by the saved-suffix reparse.
				models: [
					{
						id: "config-pick",
						name: "Config Pick",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				fetchDynamicModels: async () => {
					await catalogGate.promise;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		// Same baked session, plus the `thinking_level_change` that outranks the
		// saved selector's suffix.
		const sessionFile = path.join(tempDir, `baked-entry-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-entry-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "runtime-provider/router:low",
					role: "default",
				},
				{
					type: "thinking_level_change",
					id: "thinking-entry",
					parentId: "default-model",
					timestamp,
					thinkingLevel: ThinkingLevel.High,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-skip"));

		const created = createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			const { session } = await created;
			// The catalog never came back, and startup finished anyway.
			expect(catalogReleased).toBe(false);
			expect(session.model?.id).toBe("config-pick");
			await session.dispose();
		} finally {
			catalogReleased = true;
			catalogGate.resolve();
		}
	}, 30000);

	test("does not block startup on a cold catalog configured thinking outranks", async () => {
		// The third exclusion on the same read. Under `--reapply-config` with a
		// configured thinking value, `adoptConfigThinking` skips the saved-suffix
		// branch entirely — so the corrected value is discarded here too, and the
		// await buys nothing but the discovery timeout.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Held open for the whole of session creation, so "startup waited" and
		// "startup did not" are distinguishable without timing.
		const catalogGate = Promise.withResolvers<void>();
		let catalogReleased = false;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// The config model is STATIC, so resolving it needs no catalog: the
				// held-open fetch below is reached only by the saved-suffix reparse.
				models: [
					{
						id: "config-pick",
						name: "Config Pick",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				fetchDynamicModels: async () => {
					await catalogGate.promise;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		// Same baked session, plus the `thinking_level_change` that outranks the
		// saved selector's suffix.
		const sessionFile = path.join(tempDir, `baked-cfg-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-cfg-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "runtime-provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		// No persisted entry and no `--thinking`: config's OWN thinking value is what
		// outranks the saved suffix here, through `adoptConfigThinking`.
		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		cfgDefaultThinkingLevel.set(settings, ThinkingLevel.High);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-cfg"));

		const created = createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			const { session } = await created;
			// The catalog never came back, and startup finished anyway.
			expect(catalogReleased).toBe(false);
			expect(session.model?.id).toBe("config-pick");
			await session.dispose();
		} finally {
			catalogReleased = true;
			catalogGate.resolve();
		}
	}, 30000);

	// The config model is static, but the saved literal ID exists only after cold
	// discovery. Correcting only restoredSessionThinkingLevel misses it because
	// the resolved model prevents later recomputation, leaving the suffix applied.
	test("discovers a cold provider whose casing differs from the saved selector's", async () => {
		// Provider lookup is case-insensitive, but refresh APIs use registered keys.
		// A differently-cased selector skipped discovery, so the registry never
		// proved router:low was literal and its suffix became a thinking level.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let dynamicFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
						{
							id: "config-pick",
							name: "Config Pick",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = path.join(tempDir, `cased-provider-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "cased-provider-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					// The provider is registered lowercase; the saved string is not.
					model: "Runtime-Provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-cased-provider"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The premise, measured: the cold catalog really was fetched.
			expect(dynamicFetches).toBeGreaterThan(0);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	// This catches the converse: the registered key is mixed-case. Lowercasing the
	// parsed key misses exact refresh lookups, leaving the cold catalog unavailable
	// and the suffix misparsed. Resolve the stored key for both casing directions.
	test("discovers a cold provider registered with mixed-case identity", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let dynamicFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			// Registered with a mixed-case key the registry preserves verbatim.
			pi.registerProvider("MyGateway", {
				baseUrl: "https://gateway.example.com/v1",
				apiKey: "GATEWAY_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
						{
							id: "config-pick",
							name: "Config Pick",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "MyGateway/config-pick");
		const sessionFile = path.join(tempDir, `mixed-case-provider-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "mixed-case-provider-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					// The saved string carries the provider's true mixed-case spelling;
					// lowercasing it would miss the manager keyed `MyGateway`.
					model: "MyGateway/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-mixed-case-provider"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The premise, measured: lowercasing the provider would have skipped the
			// scoped refresh entirely, so a fetched catalog proves the resolved key hit.
			expect(dynamicFetches).toBeGreaterThan(0);
			expect(session.model?.provider).toBe("MyGateway");
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	test("matches a pinned model whose saved selector differs only in provider casing", async () => {
		// options.model must count as literal before registry discovery. Its old
		// comparison was case-sensitive, unlike provider/model lookup, so a saved
		// selector with different casing parsed the literal :low tail as thinking.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const settings = Settings.isolated();
		const sessionFile = path.join(tempDir, `cased-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "cased-suffix-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					// Same model, spelled with a different provider casing.
					model: "Runtime-Provider/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-cased"));

		// Pinned by the caller and absent from the registry, so only the identity
		// comparison can prove `router:low` is a literal id.
		const pinnedModel = buildModel({
			provider: "runtime-provider",
			id: "router:low",
			name: "Router Low",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} as ModelSpec);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
			model: pinnedModel,
		});

		try {
			expect(session.model?.id).toBe("router:low");
			// `low` is the tail of the id, never a thinking selection.
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	});

	test("recomputes the thinking level when the reparse corrects an already-resolved model", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// `config-pick` is STATIC so the config default resolves immediately and
		// `model` is set before the reparse; `router:low` lives only in the cold
		// dynamic catalog, so only the reparse can learn it is a literal id.
		const mixedExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{
						id: "config-pick",
						name: "Config Pick",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				fetchDynamicModels: async () => [
					{
						id: "router:low",
						name: "Router Low",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-mixed"));
		// An explicit `--model` pin: it fixes the identity, so the restored
		// suffix is what supplies the level — exactly where a misread bites.
		const mixedModelPin = buildModel({
			provider: "runtime-provider",
			id: "config-pick",
			name: "Config Pick",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} as ModelSpec);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [mixedExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
			model: mixedModelPin,
		});

		try {
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	}, 20000);

	// Non-UI sessions start background discovery immediately, so suffix reparsing
	// can overlap. Runtime extension managers lack the configured coalescing map,
	// allowing both passes to fetch and race catalog and cache writes.
	test("does not fetch the saved provider's catalog twice in a non-UI session", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		let concurrentFetches = 0;
		let peakConcurrentFetches = 0;
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					concurrentFetches++;
					peakConcurrentFetches = Math.max(peakConcurrentFetches, concurrentFetches);
					// Hold the fetch open so a second, overlapping pass is visible
					// as concurrency rather than two sequential cache-warm reads.
					await Bun.sleep(25);
					concurrentFetches--;
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
						{
							id: "config-pick",
							name: "Config Pick",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/config-pick");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-nonui"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
			hasUI: false,
		});

		try {
			expect(peakConcurrentFetches).toBe(1);
			expect(session.model?.id).toBe("config-pick");
			expect(session.configuredThinkingLevel()).not.toBe("low");
		} finally {
			await session.dispose();
		}
	}, 20000);

	test("reparses a cold saved suffix when the final retry makes it readable again", async () => {
		// The early guard skips reparsing when the current default names a thinking
		// suffix. A retry can select a candidate without one, making the saved suffix
		// relevant again; reparse after retry to avoid applying the stale split.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `late-models-${Bun.nanoseconds()}.yml`);
		const vllmProvider = (models: { id: string; name: string; reasoning?: boolean }[]) => ({
			vllm: { baseUrl: "https://vllm.example.invalid/v1", api: "openai-completions", auth: "none", models },
		});
		// `late-pick` is NOT here yet, so the suffixed fallback wins the first pass.
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					...vllmProvider([]),
					fallbackvend: {
						baseUrl: "https://fallback.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "fallback", name: "Fallback" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the first candidate's provider is refreshable, so
		// the discovery retry runs on its behalf at all.
		expect(modelRegistry.canRefreshProvider("vllm")).toBe(true);

		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				// Cold: the saved `router:low` is invisible, so the early parse splits
				// it at `:low`. Discovery also publishes the first candidate, which is
				// what changes the winner.
				fetchDynamicModels: async () => {
					await Bun.sleep(15);
					await Bun.write(
						modelsPath,
						JSON.stringify({
							providers: {
								...vllmProvider([{ id: "late-pick", name: "Late Pick", reasoning: true }]),
								fallbackvend: {
									baseUrl: "https://fallback.example.invalid/v1",
									api: "openai-completions",
									auth: "none",
									models: [{ id: "fallback", name: "Fallback" }],
								},
							},
						}),
					);
					return [
						{
							id: "router:low",
							name: "Router Low",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "vllm/late-pick,fallbackvend/fallback:xhigh");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-retry"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The premise, measured: the retry really did change the winner to the
			// candidate that names no thinking knob.
			expect(session.model?.id).toBe("late-pick");
			// So the saved suffix is readable again -- and the level must not be the
			// stale `low` split off a literal model id.
			expect(session.thinkingLevel).not.toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	test("drops a provisional default the post-discovery catalog no longer lists", async () => {
		// Default resolution runs again after refresh reloads models.yml. Its earlier
		// result may be gone; returning without a model skips restore and fallback,
		// leaving a model the refreshed catalog removed.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `withdrawn-models-${Bun.nanoseconds()}.yml`);
		const providerEntry = (models: { id: string; name: string }[]) => ({
			providers: {
				vend: { baseUrl: "https://vend.example.invalid/v1", api: "openai-completions", auth: "none", models },
			},
		});
		await Bun.write(modelsPath, JSON.stringify(providerEntry([{ id: "going-away", name: "Going Away" }])));
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the first resolution really can see it.
		expect(modelRegistry.find("vend", "going-away")).toBeDefined();

		// An earlier candidate that never resolves but IS discoverable, so the role
		// matches at index 1 and the post-discovery retry runs at all. Rewriting
		// models.yml from inside the fetch puts the withdrawal exactly between the
		// two `tryResolveDefaultRole()` calls, which is the race being fixed.
		const withdrawingExtension: ExtensionFactory = pi => {
			pi.registerProvider("ahead-provider", {
				baseUrl: "https://ahead.example.com/v1",
				apiKey: "AHEAD_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					await Bun.sleep(15);
					await Bun.write(modelsPath, JSON.stringify(providerEntry([{ id: "still-here", name: "Still Here" }])));
					return [];
				},
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "ahead-provider/never-there,vend/going-away");
		const sessionFile = await writeBakedSession();
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-withdrawn"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [withdrawingExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			expect(modelRegistry.find("vend", "going-away")).toBeUndefined();
			expect(session.model?.id).not.toBe("going-away");
		} finally {
			await session.dispose();
		}
	});
	test("reparses a saved suffix when a late default flips adoption false->true", async () => {
		// Late extension resolution can invalidate an earlier suffix split.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// Static discovery can change a saved suffix's meaning.
		const modelsPath = path.join(tempDir, `flip-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "router", name: "Router" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the bare id is visible early, the suffix-shaped
		// literal and the `default` model are NOT -- they arrive with the extension.
		expect(modelRegistry.find("custom", "router")).toBeDefined();
		expect(modelRegistry.find("custom", "router:low")).toBeUndefined();
		expect(modelRegistry.find("custom", "default")).toBeUndefined();

		// The extension augments the SAME provider: the literal `router:low` id (so
		// the reparse recognizes it whole and drops the invented suffix) and a
		// reasoning `default` model (so `default,@default` resolves late and a
		// level is observable at all on the model it selects).
		const augmentCustom: ExtensionFactory = pi => {
			pi.registerProvider("custom", {
				baseUrl: "https://custom.example.invalid/v1",
				apiKey: "CUSTOM_KEY",
				api: "openai-completions",
				models: [
					{
						id: "router:low",
						name: "Router Low",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
					{
						id: "default",
						name: "Late Default",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "default,@default");

		const sessionFile = path.join(tempDir, `flip-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "flip-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "custom/router:low",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-flip"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [augmentCustom],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The premise, measured: the extension really did register the literal
			// suffix-shaped id and the `default` model the config resolves to.
			expect(modelRegistry.find("custom", "router:low")).toBeDefined();
			expect(modelRegistry.find("custom", "default")).toBeDefined();
			// The adoption really did flip: the late `default` model won the config
			// default, not the baked `custom/router`.
			expect(session.model?.provider).toBe("custom");
			expect(session.model?.id).toBe("default");
			// `low` is the tail of a literal model id, so it must not ride onto
			// the late config-selected model.
			expect(session.thinkingLevel).not.toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	}, 20000);

	test("does not claim the config default failed when a late default won the adoption", async () => {
		// The first restore runs before extensions and marks the baked model restored.
		// A late extension can make the configured default win; without updating the
		// marker, the notice falsely says config resolution failed.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, `notice-models-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "https://custom.example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "router", name: "Router" }],
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		// The premise, measured: the bare `custom/router` is visible early (so the
		// early restore adopts it and seeds index 0), while the `default` model the
		// config resolves to is NOT -- it arrives with the extension.
		expect(modelRegistry.find("custom", "router")).toBeDefined();
		expect(modelRegistry.find("custom", "default")).toBeUndefined();

		const augmentCustom: ExtensionFactory = pi => {
			pi.registerProvider("custom", {
				baseUrl: "https://custom.example.invalid/v1",
				apiKey: "CUSTOM_KEY",
				api: "openai-completions",
				models: [
					{
						id: "default",
						name: "Late Default",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const settings = Settings.isolated();
		settings.setModelRole("default", "default,@default");

		const sessionFile = path.join(tempDir, `notice-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "notice-session", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "custom/router",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir, "startup-notice"));

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			extensions: [augmentCustom],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			reapplyConfig: true,
		});

		try {
			// The premise, measured: the adoption really did flip to the late config
			// `default`, not the baked `custom/router`.
			expect(session.model?.provider).toBe("custom");
			expect(session.model?.id).toBe("default");
			// The notice must not claim the config default failed or that the
			// session kept its baked model.
			expect(modelFallbackMessage ?? "").not.toContain("did not resolve");
			expect(modelFallbackMessage ?? "").not.toContain("kept the session");
			// The notice reports the config model the session actually adopted.
			expect(modelFallbackMessage).toContain("resumed on custom/default from config");
		} finally {
			await session.dispose();
		}
	}, 20000);
});
