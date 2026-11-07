import * as AIError from "@oh-my-pi/pi-ai/error";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { cfgCompactionModels } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { create, Flag } from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #5064.
 *
 * Manual `/compact` with the default snapcompact strategy hard-threw
 * ("snapcompact cannot run locally: <id> is text-only") when the active model
 * lacked image input, even though the auto-compaction path already downgraded
 * to LLM-backed compaction in the same situation. The manual path MUST mirror
 * that behavior: warn, then summarize via the LLM fallback candidate chain
 * (which tries the active text→text model first).
 *
 * An *explicit* `/compact snapcompact` (mode override) is a deliberate no-LLM
 * archive request, so it MUST keep failing locally instead of silently
 * shipping the transcript to a provider.
 */
describe("AgentSession manual snapcompact text-only fallback", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	async function createHarness(): Promise<{
		session: AgentSession;
		sessionManager: SessionManager;
		activeModel: Model;
		notices: string[];
	}> {
		const activeModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!activeModel) throw new Error("Expected bundled text-only model");
		expect(activeModel.input).not.toContain("image");

		tempDir = TempDir.createSync("@pi-manual-snapcompact-text-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("aimlapi", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const agent = new Agent({
			initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const seed: Message[] = [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: activeModel.api,
				provider: activeModel.provider,
				model: activeModel.id,
				stopReason: "stop",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: "second question", timestamp: Date.now() },
		];
		for (const message of seed) sessionManager.appendMessage(message);
		if (!sessionManager.getBranch()[0]?.id) throw new Error("Expected seeded branch entry");

		const settings = Settings.isolated({
			"compaction.methodOrder": ["snapcompact", "soft"],
			"compaction.keepRecentTokens": 1,
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
		});

		return { session, sessionManager, activeModel, notices };
	}

	it("falls back to LLM compaction instead of throwing on a text-only active model", async () => {
		const harness = await createHarness();

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "llm summary",
			shortSummary: "llm",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider, model: model.id },
		}));

		const result = await harness.session.compact();

		expect(result.summary).toBe("llm summary");
		// The preference resolver skips snapcompact and tries the active model for soft compaction.
		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "llm summary",
		});
	});

	it("advances to the next configured model on a rate limit", async () => {
		const harness = await createHarness();
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallbackModel) throw new Error("Expected bundled fallback model");
		authStorage?.keys.setRuntime(fallbackModel.provider, "test-key");
		cfgCompactionModels.override(harness.session.settings, [
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.id === harness.activeModel.id) throw new AIError.ProviderHttpError("rate limit exceeded", 429);
			return {
				summary: "fallback summary",
				shortSummary: "fallback",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		const result = await harness.session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it.each([
		["quota", new AIError.ProviderHttpError("insufficient_quota", 429)],
		["capacity", new AIError.ProviderHttpError("model capacity exhausted", 503)],
	])(
		"advances to an explicit model on a classified %s response without logging raw details",
		async (_label, limitError) => {
			const harness = await createHarness();
			const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!fallbackModel) throw new Error("Expected bundled fallback model");
			authStorage?.keys.setRuntime(fallbackModel.provider, "test-key");
			cfgCompactionModels.override(harness.session.settings, [
				`${harness.activeModel.provider}/${harness.activeModel.id}`,
				`${fallbackModel.provider}/${fallbackModel.id}`,
			]);
			const sensitiveMarker = "SENSITIVE_PROVIDER_DETAIL";
			const decoratedError = Object.assign(limitError, { message: `${limitError.message} ${sensitiveMarker}` });
			const logEvents: logger.LogEvent[] = [];
			const disposeLogSink = logger.registerLogSink(event => {
				if (event.level === "warn") logEvents.push(event);
			});
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
				if (model.provider === harness.activeModel.provider) throw decoratedError;
				return {
					summary: "fallback summary",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 42,
				};
			});

			try {
				await expect(harness.session.compact()).resolves.toMatchObject({ summary: "fallback summary" });

				expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
					`${harness.activeModel.provider}/${harness.activeModel.id}`,
					`${fallbackModel.provider}/${fallbackModel.id}`,
				]);
				expect(JSON.stringify(logEvents)).not.toContain(sensitiveMarker);
			} finally {
				disposeLogSink();
			}
		},
	);

	it("preserves terminal HTTP 400 capacity errors without trying another candidate", async () => {
		const harness = await createHarness();
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallbackModel) throw new Error("Expected bundled fallback model");
		authStorage?.keys.setRuntime(fallbackModel.provider, "test-key");
		cfgCompactionModels.override(harness.session.settings, [
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		const terminalCapacity = new AIError.ProviderHttpError("requested max_tokens exceeds model output capacity", 400);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(terminalCapacity);

		await expect(harness.session.compact()).rejects.toBe(terminalCapacity);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
	});

	it("does not advance explicit fallback for abort, user interrupt, or arbitrary errors", async () => {
		for (const failure of [
			new AIError.AbortError(),
			Object.assign(new Error("user interrupted"), { errorId: create(Flag.UserInterrupt) }),
			new Error("unexpected parser failure"),
		]) {
			const harness = await createHarness();
			const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!fallbackModel) throw new Error("Expected bundled fallback model");
			authStorage?.keys.setRuntime(fallbackModel.provider, "test-key");
			cfgCompactionModels.override(harness.session.settings, [
				`${harness.activeModel.provider}/${harness.activeModel.id}`,
				`${fallbackModel.provider}/${fallbackModel.id}`,
			]);
			const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(failure);

			await expect(harness.session.compact()).rejects.toBe(failure);

			expect(compactSpy).toHaveBeenCalledTimes(1);
			expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
			await harness.session.dispose();
			session = undefined;
			vi.restoreAllMocks();
		}
	});
	it("does not advance explicit fallback after the compaction signal is aborted", async () => {
		const harness = await createHarness();
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallbackModel) throw new Error("Expected bundled fallback model");
		authStorage?.keys.setRuntime(fallbackModel.provider, "test-key");
		cfgCompactionModels.override(harness.session.settings, [
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		const abortError = new AIError.ProviderHttpError("rate limit exceeded", 429);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			harness.session.abortCompaction();
			throw abortError;
		});

		await expect(harness.session.compact()).rejects.toBe(abortError);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
	});
	it("keeps native manual compaction failures inside the provider lane", async () => {
		const harness = await createHarness();
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallbackModel) throw new Error("Expected bundled fallback model");
		authStorage?.keys.setRuntime(fallbackModel.provider, "test-key");
		cfgCompactionModels.override(harness.session.settings, [
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		const nativeFailure = new compactionModule.NativeCompactionError(new Error("native transport failed"));
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(nativeFailure);

		await expect(harness.session.compact()).rejects.toBe(nativeFailure);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls.map(([, candidate]) => `${candidate.provider}/${candidate.id}`)).toEqual([
			`${harness.activeModel.provider}/${harness.activeModel.id}`,
		]);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
	});
	it("preserves a classified rate-limit error without an explicit model list", async () => {
		const harness = await createHarness();
		const rateLimit = new AIError.ProviderHttpError("rate limit exceeded", 429);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(rateLimit);

		await expect(harness.session.compact()).rejects.toBe(rateLimit);
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("still fails locally for explicit /compact snapcompact on a text-only model (no-LLM contract)", async () => {
		const harness = await createHarness();

		const compactSpy = vi.spyOn(compactionModule, "compact");

		await expect(harness.session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			`snapcompact cannot run locally: ${harness.activeModel.id} is text-only.`,
		);

		// Explicit no-LLM request must never reach the provider-backed summarizer.
		expect(compactSpy).not.toHaveBeenCalled();
		expect(harness.notices).toContain(
			`snapcompact needs a vision-capable model (${harness.activeModel.id} is text-only)`,
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toBeUndefined();
	});
});
