/**
 * Three more surfaces `refresh('settings')` reloads but historically failed to
 * reconcile into LIVE state, all of the same shape as the queue modes and
 * generation settings: the value is copied out of `Settings` once at
 * construction, and the thing that consumes it reads the copy — never
 * `settings.get(...)` — so a reload alone left the running session on its
 * launch-time behavior while the refresh reported success.
 *
 *   - The per-family SERVICE TIER. Startup copies `tier.openai`/`tier.anthropic`/
 *     `tier.google` into `ModelControls`'s private map, and
 *     `agent.serviceTierResolver` consults that map on every request.
 *   - The tool sets whose EXISTENCE is gated on a setting
 *     (`generate_image.enabled`, `speechgen.enabled`). sdk.ts pushes both into
 *     `customTools` at construction with no later registration or removal path,
 *     so an enable left the tools unavailable and a disable left them callable.
 *   - The model-pin classifier's reading of a ROLE-LESS `model_change`, which is
 *     ambiguous on a transcript written before the cycle paths recorded a role:
 *     it is either startup's settings-derived receipt (swappable) or an older
 *     Ctrl+P cycle pin (must be preserved).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function bundledAnthropic(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled anthropic model ${id}`);
	return model as Model<Api>;
}

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	modelA: Model<Api>;
	dispose: () => Promise<void>;
}

/**
 * `persistSession` swaps the in-memory transcript for a FILE-backed one, which
 * a round-trip case needs: `switchSession` reloads from the session file, and
 * that reload is where the persisted `service_tier_change` snapshot is replayed
 * over the live map.
 */

/**
 * A bundled ANTHROPIC model, not a synthetic one: `serviceTierFamily` maps a
 * model to its tier family from real provider/api metadata, so a made-up
 * provider has no family at all and every tier assertion would pass vacuously.
 *
 * `overrides` is a CONFIG OVERLAY on the isolated `Settings`, which is how the
 * harness keeps `compaction.enabled` off without competing with the on-disk
 * `config.yml` each test rewrites — `#readProjectSettings` serves the project
 * layers through a process-lifetime capability cache, so an override is the
 * layer a test can set once and rely on across the reload.
 */
async function makeHarness(
	initialConfig: string,
	options?: { persistSession?: boolean; customTools?: CustomTool[] },
): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-live-tiers-tools-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	const modelA = bundledAnthropic("claude-sonnet-4-5");
	// Staged BEFORE construction so the session starts from these values and
	// each test observes a real transition, not a first-time application.
	await fs.writeFile(settingsPath, initialConfig);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: options?.persistSession
			? SessionManager.create(cwd, path.join(cwd, "transcript"))
			: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false },
		}),
		model: modelA,
		disableExtensionDiscovery: true,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		customTools: options?.customTools,
	});

	return {
		session,
		cwd,
		settingsPath,
		modelA,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh('settings'): live service tiers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies a reloaded per-family service tier to the live request resolver", async () => {
		const h = await makeHarness("tier:\n  anthropic: none\n");
		try {
			expect(h.session.serviceTierByFamily.anthropic).toBeUndefined();

			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: priority\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: startup copied `tier.*` into `ModelControls`'s private map
			// and the reload never touched it, so the refresh reported success
			// while requests kept the launch-time tier.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
			// The resolver is what actually reaches the wire, and it reads the map
			// per request rather than the settings.
			expect(h.session.agent.serviceTierResolver?.(h.modelA)).toBe("priority");
		} finally {
			await h.dispose();
		}
	});

	it("clears a per-family tier when the setting goes back to none", async () => {
		// The serious direction: leaving `priority` live after it was turned off
		// keeps billing every request at the priority tier.
		const h = await makeHarness("tier:\n  anthropic: priority\n");
		try {
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.serviceTierByFamily.anthropic).toBeUndefined();
			expect(h.session.agent.serviceTierResolver?.(h.modelA)).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("leaves a session-local /fast selection alone when the config tier did not move", async () => {
		// Guard against a blind re-apply: `/fast`, the settings selector, and an
		// RPC/ACP client all write the live map directly, and such a selection is
		// invisible to the config file — exactly the shape the queue modes and
		// provider globals are also protected against.
		const h = await makeHarness("tier:\n  anthropic: none\n");
		try {
			h.session.setServiceTierFamily("anthropic", "priority");
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			// An UNRELATED settings edit. `tier.anthropic` is still `none`, so the
			// reconcile must not pull the session back off its own selection.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\nincludeModelInPrompt: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	});

	it("keeps a session-local selection even when the configured tier itself moves", async () => {
		// The stronger half, and the one the unrelated-edit case above cannot
		// reach: when `tier.anthropic` genuinely CHANGES, the family is no longer
		// skipped for being unmoved, so only the live-vs-previous comparison stops
		// the config from overwriting a selection the operator made at runtime.
		const h = await makeHarness("tier:\n  anthropic: none\n");
		try {
			h.session.setServiceTierFamily("anthropic", "priority");
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			// `none` -> `standard`: a real config move on the very family the
			// session has its own selection for.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: standard\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The runtime selection outranks a config value the session never followed.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	});

	it("keeps a refreshed family's tier across a switch away and back", async () => {
		// The initial write was never the failure: a `service_tier_change` is a
		// WHOLE-MAP snapshot, so an earlier `/fast` on ONE family froze every
		// other family's pre-refresh value into it. Restoration replays the last
		// snapshot wholesale, so switching away and back reverted exactly the
		// families the refresh had just moved.
		const h = await makeHarness("tier:\n  anthropic: none\n  openai: none\n", { persistSession: true });
		try {
			// A session-local selection on ANOTHER family writes the whole-map
			// receipt — `{ anthropic: "priority" }`, with openai still absent.
			h.session.setServiceTierFamily("anthropic", "priority");

			// The refresh moves the openai family, which is still config-tracking.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\n  openai: flex\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.serviceTierByFamily.openai).toBe("flex");
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			// The round trip: a real reload through the persisted transcript.
			// Persistence is lazy — the JSONL only materializes once the history
			// holds an assistant message — so without a real reply `switchSession`
			// reloads nothing and every tier falls back to the configured map,
			// which would let the assertion below pass vacuously.
			h.session.sessionManager.appendMessage({
				role: "assistant",
				provider: "anthropic",
				model: h.modelA.id,
				content: [{ type: "text", text: "reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await h.session.sessionManager.flush();
			expect(await h.session.switchSession(sessionFile)).toBe(true);

			// Pre-fix: the newest snapshot was the pre-refresh `/fast` one, whose
			// openai entry was absent, so the reconciled `flex` vanished.
			expect(h.session.serviceTierByFamily.openai).toBe("flex");
			// And the earlier session-local selection must still survive it.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	}, 20_000);
});

describe("AgentSession refresh('settings'): setting-gated tool sets", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("installs the image and speech tools when their settings are enabled on disk", async () => {
		const h = await makeHarness("generate_image:\n  enabled: false\nspeechgen:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("generate_image");
			expect(h.session.getEnabledToolNames()).not.toContain("tts");

			await fs.writeFile(h.settingsPath, "generate_image:\n  enabled: true\nspeechgen:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: both sets were added only at startup, with no later
			// registration path, so enabling them left the tools unavailable while
			// the refresh reported the settings updated.
			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).toContain("tts");
			// Registered, not merely named: the model has to be able to call them.
			expect(h.session.getToolByName("generate_image")).toBeDefined();
			expect(h.session.getToolByName("tts")).toBeDefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("removes the image and speech tools when their settings are disabled on disk", async () => {
		// The serious direction: a disabled tool that stays active is still
		// advertised to the model and still callable.
		const h = await makeHarness("generate_image:\n  enabled: true\nspeechgen:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).toContain("tts");

			await fs.writeFile(h.settingsPath, "generate_image:\n  enabled: false\nspeechgen:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("generate_image");
			expect(h.session.getEnabledToolNames()).not.toContain("tts");
		} finally {
			await h.dispose();
		}
	});

	it("reconciles each gated set independently", async () => {
		// The two settings are separate levers, so moving one must not disturb
		// the other's live state.
		const h = await makeHarness("generate_image:\n  enabled: true\nspeechgen:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).not.toContain("tts");

			await fs.writeFile(h.settingsPath, "generate_image:\n  enabled: true\nspeechgen:\n  enabled: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).toContain("tts");
		} finally {
			await h.dispose();
		}
	});

	it("restores a re-enabled set after a disable round trip", async () => {
		// A disable preserves the registry entry, so the re-enable must
		// re-activate the existing tool rather than silently finding nothing to
		// install.
		const h = await makeHarness("speechgen:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("tts");

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("tts");

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).toContain("tts");
		} finally {
			await h.dispose();
		}
	});
});

// A role-less, unflagged `model_change` is genuinely ambiguous: both startup's
// settings-derived receipt and an older Ctrl+P cycle pin wrote that exact shape,
// and the field that would separate them is the one neither writer set. Their
// POSITION separates them — startup's receipt is written before the session has
// any message — so the classifier reads position rather than trusting the
// missing role.
describe("createAgentSession resume: a historical role-less cycle pin survives a settings refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Persist a prior transcript, then resume it through the real SDK path.
	 * `seed` writes the branch; persistence is lazy, so the caller must append a
	 * full user+assistant exchange or the JSONL never materializes.
	 */
	async function resumeWithBranch(
		seed: (manager: SessionManager, models: { modelA: Model<Api>; modelB: Model<Api> }) => void,
		configuredDefault: Model<Api>,
	): Promise<{ session: AgentSession; dispose: () => Promise<void>; settingsPath: string }> {
		const tempDir = TempDir.createSync("@pi-refresh-roleless-pin-");
		const cwd = tempDir.path();
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const modelB = bundledAnthropic("claude-sonnet-4-6");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settingsPath = path.join(cwd, "config.yml");
		await fs.writeFile(
			settingsPath,
			`modelRoles:\n  default: ${configuredDefault.provider}/${configuredDefault.id}\n`,
		);

		const prior = SessionManager.create(cwd, path.join(cwd, "prior"));
		seed(prior, { modelA, modelB });
		const sessionFile = prior.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await prior.close();

		const sessionManager = await SessionManager.open(sessionFile, path.join(cwd, "prior"));
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: await Settings.loadIsolated({
				cwd,
				agentDir: cwd,
				overrides: { "compaction.enabled": false },
			}),
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		return {
			session,
			settingsPath,
			dispose: async () => {
				await session.dispose();
				authStorage.close();
				await tempDir.remove();
			},
		};
	}

	function appendExchange(manager: SessionManager, model: Model<Api>): void {
		manager.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: model.id,
			content: [{ type: "text", text: "earlier reply" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	it("preserves a role-less model_change written mid-session (the older cycle shape)", async () => {
		const modelC = bundledAnthropic("claude-haiku-4-5");
		// The prior transcript: startup's role-less receipt, a real exchange, then
		// a SECOND role-less entry — exactly what Ctrl+P recorded before the cycle
		// paths started writing role "default".
		const h = await resumeWithBranch((manager, { modelA, modelB }) => {
			manager.appendModelChange(`${modelA.provider}/${modelA.id}`);
			appendExchange(manager, modelA);
			manager.appendModelChange(`${modelB.provider}/${modelB.id}`);
		}, modelC);
		try {
			const modelB = bundledAnthropic("claude-sonnet-4-6");
			expect(h.session.model?.id).toBe(modelB.id);

			// The configured default is a THIRD model, so an unwanted auto-swap
			// would visibly replace the cycled one.
			await fs.writeFile(
				h.settingsPath,
				`modelRoles:\n  default: ${modelC.provider}/${modelC.id}\nincludeModelInPrompt: false\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the classifier read every role-less entry as
			// settings-tracking, so the refresh discarded the user's cycle pin.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("still swaps a role-less startup receipt that precedes every message", async () => {
		// The other half of the discriminator, and the reason it cannot simply
		// treat every role-less entry as a pin: a settings-derived startup keeps
		// following the configured default.
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const modelB = bundledAnthropic("claude-sonnet-4-6");
		const h = await resumeWithBranch(manager => {
			manager.appendModelChange(`${modelA.provider}/${modelA.id}`);
			appendExchange(manager, modelA);
		}, modelB);
		try {
			// Resume restores the model the TRANSCRIPT was running, not the
			// configured default, so the swap below is a real transition.
			expect(h.session.model?.id).toBe(modelA.id);

			await fs.writeFile(
				h.settingsPath,
				`modelRoles:\n  default: ${modelB.provider}/${modelB.id}\nincludeModelInPrompt: false\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a same-named custom tool active when the built-in feature is disabled", async () => {
		// An extension or SDK tool may re-register `tts`, replacing the registry
		// entry while keeping the name. Disabling `speechgen` must drop only the
		// built-in it gates: the override is somebody else's tool, and a freshly
		// started session under the new setting would still offer it. Pre-fix the
		// disable removed the ACTIVE NAME, taking the override down with it.
		const override: CustomTool = {
			name: "tts",
			label: "Custom TTS",
			description: "An extension-provided tool that happens to share the built-in's name.",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "custom tts" }] }),
		} as unknown as CustomTool;
		const h = await makeHarness("speechgen:\n  enabled: true\n", { customTools: [override] });
		try {
			expect(h.session.getEnabledToolNames()).toContain("tts");

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			// The name survives because the entry behind it is the override, not
			// the setting-gated built-in.
			expect(h.session.getEnabledToolNames()).toContain("tts");
			expect(h.session.getToolByName("tts")?.description).toContain("An extension-provided tool");
		} finally {
			await h.dispose();
		}
	});

	it("clears the registry entry when a setting-gated built-in is disabled", async () => {
		// Dropping only the ACTIVE NAME leaves an inactive registry entry behind,
		// and the late-registration path in `sdk.ts` reads any existing entry as
		// an incumbent to defer to — so an extension registering `tts` after the
		// disable would be declined, while a session freshly started under the
		// same setting exposes it. The gated group therefore removes the entries
		// it owns, leaving the name genuinely free.
		const h = await makeHarness("speechgen:\n  enabled: true\n");
		try {
			expect(h.session.getToolByName("tts")).toBeDefined();

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).not.toContain("tts");
			expect(h.session.getToolByName("tts")).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});
});
