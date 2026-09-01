/**
 * Contract: the cooperative restart barrier must not dispose the session while a
 * prompt is still in session-level setup.
 *
 * The #restarting latch stops NEW turns from starting, but a prompt that already
 * passed the latch check inside #promptWithMessage can still be awaiting async
 * setup — API-key resolution, @-mention loading, a before_agent_start hook, or
 * pre-prompt compaction — before it reaches the agent. #doRequestRestart's
 * quiescence wait (waitForIdle) watches only the core agent loop and recovery
 * tasks, not #promptInFlightCount, so it resolves immediately in that window and
 * the restart flushes/disposes out from under the preparing prompt; the prompt
 * then continues into promptAgentWithIdleRetry() and appends against a disposed
 * session. The barrier must additionally wait for #promptInFlightCount to drain
 * so a mid-setup prompt blocks dispose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession restart barrier waits for in-flight prompt setup", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mock: ReturnType<typeof createMockModel>;
	let releaseApiKey: (() => void) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-restart-inflight-");
	});

	afterEach(async () => {
		releaseApiKey?.();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
		vi.restoreAllMocks();
	});

	/** Build a live, file-backed session with no gating on the restart path. */
	async function buildLiveSession(): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			onRestartRequested: () => {},
		});
	}

	it("blocks dispose while a prompt is parked in post-latch API-key setup, then disposes once it finishes", async () => {
		await buildLiveSession();

		// Gate API-key resolution so the prompt parks inside #promptWithMessage's
		// setup — after passing the #restarting latch check and #beginInFlight, but
		// before it reaches the agent. This is the exact post-latch/pre-dispose
		// window the barrier must cover.
		const apiKeyGate = Promise.withResolvers<string | undefined>();
		releaseApiKey = () => apiKeyGate.resolve("test-key");
		vi.spyOn(modelRegistry, "getApiKey").mockReturnValue(apiKeyGate.promise);

		// Observe when dispose begins.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Start a prompt; it advances into setup and parks on the gated key.
		const prompt = session.prompt("do the thing");
		for (let i = 0; i < 200 && !session.isStreaming; i++) {
			await scheduler.wait(1);
		}
		// #promptInFlightCount > 0 surfaces as isStreaming even though the agent
		// loop has not started — the prompt is mid-setup.
		expect(session.isStreaming).toBe(true);

		// Fire the restart. Its quiescence wait resolves immediately (agent idle),
		// so only the #promptInFlightCount barrier keeps dispose from proceeding.
		const restart = session.requestRestart();

		// Give the barrier ample opportunity to (wrongly) flush and dispose under
		// the still-preparing prompt.
		for (let i = 0; i < 100 && !disposeStarted; i++) {
			await scheduler.wait(1);
		}
		expect(disposeStarted).toBe(false);

		// Release the setup gate: the prompt completes, the barrier unblocks, and
		// only now does dispose run.
		releaseApiKey?.();
		expect(await prompt).toBe(true);
		expect(await restart).toEqual({ ok: true });
		expect(disposeStarted).toBe(true);
	});
});
