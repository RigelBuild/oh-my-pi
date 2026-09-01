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
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession restart barrier waits for in-flight prompt setup", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mock: MockModel;
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

	it("blocks dispose while a steer parked in queued-input image preprocessing has not enqueued, then refuses busy", async () => {
		await buildLiveSession();

		// Park the restart at its post-idle quiescence wait so it latches
		// #restarting and passes its pre-latch #hasUnpersistedInput check BEFORE
		// the steer's preparation begins. Only then does the steer enter the exact
		// race: input in async preparation that has passed the latch but reached
		// neither agent queue nor #promptInFlightCount.
		const idleGate = Promise.withResolvers<void>();
		vi.spyOn(session, "waitForIdle").mockReturnValue(idleGate.promise);

		// Gate image normalization so the steer parks inside #queueUserMessage's
		// async preparation before either agent queue is populated.
		const normalizeGate = Promise.withResolvers<void>();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			await normalizeGate.promise;
			return images;
		});

		// Observe when dispose begins.
		let disposeStarted = false;
		const realDispose = session.dispose.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(options => {
			disposeStarted = true;
			return realDispose(options);
		});

		// Latch the restart; it parks on the gated quiescence wait.
		const restart = session.requestRestart();

		// A host/extension steer that calls agent.steer directly (never the
		// turn-start latch), landing after the restart latched. It advances into
		// #queueUserMessage and parks on the gated normalization — in preparation,
		// not yet enqueued.
		const steer = session.steer("resume the work", [image]);
		for (let i = 0; i < 50; i++) {
			await scheduler.wait(1);
		}
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the quiescence gate: the barrier resumes. #promptInFlightCount is
		// zero, so only the queued-input preprocessing barrier can keep dispose from
		// running. Give it ample opportunity to (wrongly) flush and dispose out from
		// under the still-preparing steer.
		idleGate.resolve();
		for (let i = 0; i < 100 && !disposeStarted; i++) {
			await scheduler.wait(1);
		}
		expect(disposeStarted).toBe(false);
		// The preparing input was not lost to a dead agent: dispose is blocked and
		// the message still has not reached the queue.
		expect(session.agent.hasQueuedMessages()).toBe(false);

		// Release the normalization gate: the steer enqueues, the prep barrier
		// unblocks, and the barrier now observes queued input — so it refuses the
		// recycle rather than disposing under it.
		normalizeGate.resolve();
		await steer;
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(await restart).toEqual({ ok: false, reason: "busy" });
		expect(disposeStarted).toBe(false);
	});
});
