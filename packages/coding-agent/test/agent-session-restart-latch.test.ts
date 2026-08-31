/**
 * Contract: once a cooperative restart is latched (`#restarting`), no turn may
 * start — but the latch must not silently swallow the input a caller handed in.
 * Every prompt path gives the caller an OBSERVABLE signal so it can persist /
 * restore the input and never leave a protocol host waiting for an `agent_end`
 * that will never fire:
 *  - prompt() hands a dropped user prompt back through the drop hook.
 *  - promptCustomMessage() reports `false` (no turn started).
 *  - sendCustomMessage({ triggerTurn }) reports `false` instead of a false `true`.
 *
 * The latch is held open (but the session kept alive and undisposed) by gating
 * the durability flush inside requestRestart(), so the assertions run in the
 * real post-latch / pre-dispose window rather than against a torn-down session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { DroppedPrompt } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession restart-latch prompt contract", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let releaseFlush: (() => void) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-restart-latch-");
	});

	afterEach(async () => {
		releaseFlush?.();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
		vi.restoreAllMocks();
	});

	/**
	 * Build a live, file-backed session whose durability flush is gated open, so
	 * a restart requested against it latches `#restarting` and then parks before
	 * dispose. The gate is released in afterEach via `releaseFlush`.
	 */
	async function buildSession(config?: {
		customCommands?: LoadedCustomCommand[];
		onRestartRequested?: () => void | Promise<void>;
	}): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			customCommands: config?.customCommands,
			onRestartRequested: config?.onRestartRequested ?? (() => {}),
		});

		const flushGate = Promise.withResolvers<void>();
		releaseFlush = flushGate.resolve;
		// Gate the durability barrier so #doRequestRestart parks after latching
		// #restarting but before dispose — the exact post-latch/pre-dispose window.
		// Released in afterEach via releaseFlush.
		vi.spyOn(sessionManager, "flush").mockReturnValue(flushGate.promise);
	}

	/**
	 * Build a live, file-backed session and latch a restart that hangs at the
	 * durability flush, so `#restarting` is set but dispose never completes.
	 * Returns once the latch is committed.
	 */
	async function latchedSession(): Promise<void> {
		await buildSession();
		// requestRestart() sets #restarting synchronously before its first await,
		// so the session is latched the moment this returns. The returned promise
		// stays pending on the gated flush; released in afterEach.
		void session.requestRestart();
	}

	it("hands a latched user prompt back through the drop hook instead of losing it", async () => {
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const forwarded = await session.prompt("please do the thing");

		expect(forwarded).toBe(false);
		expect(dropped).toEqual([{ text: "please do the thing", images: undefined }]);
	});

	it("does not surface a synthetic latched prompt (agent-initiated input is not replayed)", async () => {
		await latchedSession();
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const forwarded = await session.prompt("auto-continue", { synthetic: true });

		expect(forwarded).toBe(false);
		expect(dropped).toEqual([]);
	});

	it("returns false and drops a user prompt latched mid-flight after passing the top guard", async () => {
		// The real race prompt() must survive: a user prompt clears the
		// top-of-prompt() latch check, then a concurrent restart latches
		// #restarting while the prompt is still in async preprocessing, so the
		// SECOND guard inside #promptWithMessage refuses it. A custom slash
		// command reproduces that window deterministically — its execute() runs
		// AFTER the top guard but BEFORE #promptWithMessage, and requestRestart()
		// sets #restarting synchronously, so the shared chokepoint sees the latch
		// and returns false. prompt() must propagate that false (not a stale
		// unconditional true) so a lifecycle host does not await a dead agent_end,
		// and must still hand the input back through the drop hook.
		const latch: LoadedCustomCommand = {
			path: "latch.ts",
			resolvedPath: "latch.ts",
			source: "project",
			command: {
				name: "latch",
				description: "latch a restart mid-prompt",
				execute: () => {
					void session.requestRestart();
					return "do the thing";
				},
			},
		};
		await buildSession({ customCommands: [latch] });
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const forwarded = await session.prompt("/latch");

		expect(forwarded).toBe(false);
		expect(dropped).toEqual([{ text: "/latch", images: undefined }]);
	});

	it("reports promptCustomMessage as not-dispatched when latched", async () => {
		await latchedSession();

		const dispatched = await session.promptCustomMessage({
			customType: "skill-prompt",
			content: "run skill",
			display: true,
			attribution: "user",
		});

		expect(dispatched).toBe(false);
	});

	it("reports sendCustomMessage({ triggerTurn }) as no-turn-started when latched", async () => {
		await latchedSession();

		const started = await session.sendCustomMessage(
			{ customType: "advisor", content: "note", display: false, attribution: "agent" },
			{ triggerTurn: true },
		);

		expect(started).toBe(false);
	});
});
