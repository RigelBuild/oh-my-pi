/**
 * A saved session model whose LITERAL id ends in an effort name
 * (`runtime-provider/router:low`) must not have that segment read as the
 * session's thinking choice.
 *
 * The saved selector's suffix is parsed early — before extensions load —
 * whenever config or `--model` supplies the identity. `isLiteralModelId` is
 * answered by the registry, which has no extension providers yet, so the whole
 * id is unrecognizable there and `:low` looks like a thinking suffix. That
 * misread level was then carried onto the config-selected model. The parse has
 * to run again once the providers are registered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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

	/** A resumable session whose only model entry is the suffix-shaped literal id. */
	async function writeBakedSession(): Promise<string> {
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
					model: "runtime-provider/router:low",
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
});
