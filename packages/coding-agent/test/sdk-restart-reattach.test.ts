/**
 * Reconstruction contract (host-owned): after a restart the embedder reopens the
 * durable session and rebuilds the replacement through the SAME factory, but must
 * OMIT the discovery-backed preload fields (contextFiles / skills /
 * promptTemplates / slashCommands / preloadedExtensions) so `createAgentSession`
 * re-runs disk discovery and picks up host-staged changes — the whole point of
 * restart. This proves the boundary: with on-disk AGENTS.md CHANGED between the
 * two sessions and the preload omitted, the replacement session's system prompt
 * carries the CHANGED content, not the value captured at first launch.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { reset as resetDiscoveryCaches } from "@oh-my-pi/pi-coding-agent/discovery";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "restart-reattach-model",
		name: "Restart Reattach Model",
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

describe("restart reconstruction reattach", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	it("loads on-disk-changed context when the replacement omits the preload fields", async () => {
		using tempDir = TempDir.createSync("@pi-restart-reattach-");
		const marker = Bun.nanoseconds().toString(36);
		const original = `ORIGINAL_RULES_${marker}`;
		const updated = `UPDATED_RULES_${marker}`;
		const agentsMd = path.join(tempDir.path(), "AGENTS.md");
		await fs.writeFile(agentsMd, original);

		const api = `restart-reattach-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		// The host captures the discovery-backed preload at first launch. This is
		// the STALE value that must NOT survive the restart boundary.
		const stalePreloadContextFiles = [{ path: agentsMd, content: original }];

		// First session: launched with the preload populated, backed by a real file.
		const firstManager = SessionManager.create(tempDir.path());
		const { session: first } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: firstManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: stalePreloadContextFiles,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		await first.refreshBaseSystemPrompt();
		expect(first.systemPrompt.join("\n")).toContain(original);
		// Durability barrier: requestRestart() flushes + forces the file onto disk
		// before dispose, so the host can reopen it. Mirror that here (persistence
		// is otherwise lazy until an assistant turn writes).
		await firstManager.ensureOnDisk();
		await firstManager.flush();
		const sessionFile = first.sessionFile;
		if (!sessionFile) throw new Error("Expected a durable session file for reattach");

		// Restart boundary: dispose the old session, then the on-disk context
		// changes (a host-staged edit restart exists to pick up). An in-process
		// recycle shares OMP's process-global discovery caches, so the boundary
		// must invalidate them for rediscovery to see disk — the same
		// resetCapabilities() step `AgentSession.newSession()` performs internally.
		await first.dispose();
		await fs.writeFile(agentsMd, updated);
		resetDiscoveryCaches();
		// Replacement session: reopen the durable transcript and rebuild through the
		// same factory — but OMIT contextFiles/skills/promptTemplates/slashCommands
		// (and preloadedExtensions) so discovery re-runs against the changed disk.
		const reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
		const { session: replacement } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: reopenedManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			// Discovery-backed preload intentionally omitted so restart reloads disk.
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			await replacement.refreshBaseSystemPrompt();
			const rebuilt = replacement.systemPrompt.join("\n");
			expect(rebuilt).toContain(updated);
			expect(rebuilt).not.toContain(original);
		} finally {
			await replacement.dispose();
			await reopenedManager.close();
		}
	});
});
