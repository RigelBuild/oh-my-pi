/**
 * `/refresh settings` model-swap precedence, exercised through the real
 * `createAgentSession` SDK path against on-disk config, so it defends the
 * user-visible contract:
 *
 *   - An EXPLICIT in-session `/model` pick (role `default`) survives a later
 *     `refresh('settings')` that changed the configured default. The auto-swap
 *     must not clobber a user pin. (Pre-fix, the swap predicate treated role
 *     `default` as still-tracking and replaced the pick.)
 *   - A session with NO explicit pick (startup role undefined, or a prior
 *     settings-tracking auto-swap) STILL follows the reloaded default. The
 *     tracking marker keeps the session swappable across refreshes.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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
	modelB: Model<Api>;
	dispose: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-model-swap-");
	const cwd = tempDir.path();
	const modelA = bundledAnthropic("claude-sonnet-4-5");
	const modelB = bundledAnthropic("claude-sonnet-4-6");

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const settingsPath = path.join(cwd, "config.yml");
	await fs.writeFile(settingsPath, "modelRoles:\n  default: anthropic/claude-sonnet-4-5\n");

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
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
	});

	return {
		session,
		cwd,
		settingsPath,
		modelA,
		modelB,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh('settings'): model-swap precedence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an explicit in-session model pick across a settings refresh", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user explicitly pins model-b this session. `setModel` with no role
			// writes role "default", exactly as an ACP/RPC/selector pick does.
			await h.session.setModel(h.modelB);
			expect(h.session.model?.id).toBe(h.modelB.id);

			// The configured default changes on disk to a THIRD model, then refresh.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: role "default" read as still-tracking, so the swap clobbered
			// the pin. Post-fix: an explicit "default" is a pin — no swap.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("follows the reloaded default when the session has no explicit pick", async () => {
		const h = await makeHarness();
		try {
			// Startup wrote the initial model_change with role UNDEFINED (no pin).
			expect(h.session.model?.id).toBe(h.modelA.id);

			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("keeps following the default after a prior settings-tracking swap", async () => {
		const h = await makeHarness();
		try {
			// First refresh performs a tracking auto-swap (role sentinel, not a pin).
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`);
			const first = await h.session.refresh("settings");
			expect(first.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);

			// A second on-disk change must still swap: the tracking marker left the
			// session swappable, unlike an explicit pin.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`);
			const second = await h.session.refresh("settings");
			expect(second.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelA.id);
		} finally {
			await h.dispose();
		}
	});

	it("treats a user role literally named 'settings' as a PINNED explicit pick", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user configures a CUSTOM model role NAMED "settings" and picks it.
			// This must read as an explicit pin, never as the internal auto-swap
			// marker (which is now a dedicated entry flag, not the role string).
			await h.session.setModel(h.modelB, "settings");
			expect(h.session.model?.id).toBe(h.modelB.id);

			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix (role string "settings" overloaded as the marker), the swap
			// predicate read this as still-tracking and clobbered the pick.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("still swaps a flag-marked settings-tracking entry (auto-swap stays swappable)", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// First refresh auto-swaps: the model_change is marked with the
			// settingsTracking flag (role "default"), not a role sentinel.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`);
			expect((await h.session.refresh("settings")).modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
			// The flag left the session swappable, so a later change swaps again —
			// even though the marker entry carries role "default".
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const second = await h.session.refresh("settings");
			expect(second.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(modelC.id);
		} finally {
			await h.dispose();
		}
	});

	it("preserves an explicitly cycled model across a settings refresh", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user cycles the active model (alt+m style). A cycle is an
			// explicit user pick, exactly like `setModel`, so it must survive a
			// later refresh that changed the configured default.
			const cycled = await h.session.cycleModel();
			if (!cycled) throw new Error("Expected cycleModel to switch models");
			const cycledId = cycled.model.id;
			expect(h.session.model?.id).toBe(cycledId);

			// Change the on-disk default to a model that is NOT the cycled one (and
			// differs from the current on-disk default modelA), so an unwanted
			// auto-swap would visibly replace the cycled model.
			const newDefault = [h.modelB, modelC].find(m => m.id !== cycledId);
			if (!newDefault) throw new Error("Expected a distinct model for the new default");
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${newDefault.provider}/${newDefault.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the cycle recorded a role-less, non-tracking model_change,
			// so the swap predicate read it as still-tracking and clobbered it.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(cycledId);
		} finally {
			await h.dispose();
		}
	});

	it("preserves a user pin buried beneath an ephemeral retry-fallback entry", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user explicitly pins model-b this session.
			await h.session.setModel(h.modelB);
			expect(h.session.model?.id).toBe(h.modelB.id);

			// Retry recovery later appends an ephemeral fallback transition on top
			// of the pin, exactly as the retry-fallback path records it: role
			// "fallback", resolvedModelIsFallback true. It masks the pin as the
			// newest model_change but is not itself a user choice.
			h.session.sessionManager.appendModelChange(
				`${modelC.provider}/${modelC.id}`,
				EPHEMERAL_MODEL_CHANGE_ROLE,
				true,
			);

			// The configured default changes on disk, then refresh runs while the
			// fallback entry is the latest transition.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the classifier stopped at the ephemeral entry and read it as
			// "no pin", so the swap clobbered model-b. Post-fix: it walks past the
			// fallback to the underlying pin and preserves it.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});
});
