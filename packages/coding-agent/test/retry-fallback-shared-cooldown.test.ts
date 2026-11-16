import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const TRANSPORT_ERROR = "Unable to connect. Is the computer able to access the url?";
const SOCKET_CLOSED = "The socket connection was closed unexpectedly. For more information, pass `verbose: true`";
const USAGE_LIMIT = "429 usage_limit_reached";

/**
 * A subagent and its parent share one `ModelRegistry`, so a cooldown written by
 * one session is seen by the other. These tests use one shared registry and
 * seed the cooldown the way a sibling session would.
 */
describe("retry fallback cooldown shared across sessions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-shared-cooldown-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	/** Run one prompt whose primary fails with `primaryError`, against a single-hop chain. */
	async function runPrimaryFailure(primaryError: string, clockMocked = false) {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled test models to exist");
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });

		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push(
					model.id === primaryModel.id
						? { throw: primaryError }
						: { content: [`ok:${model.provider}/${model.id}`] },
				);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			// A wait past this cap ends the same-model retry, so the walk must use a candidate.
			"retry.maxDelayMs": 100,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		if (!clockMocked) mockSchedulerWaitWithClock();

		await session.prompt("trigger the fallback");
		await session.waitForIdle();
		return { primaryModel, fallbackModel, requestedModels, events };
	}

	it("switches to a chain candidate that a sibling's transport error cooled down, on a usage-limit failure", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled test models to exist");

		// A sibling session on the same registry hit a transport failure on the
		// fallback. That wrote a cooldown on it.
		modelRegistry.suppressSelector(`${fallbackModel.provider}/${fallbackModel.id}`, Date.now() + 5 * 60 * 1000);
		expect(modelRegistry.isSelectorSuppressed(`${fallbackModel.provider}/${fallbackModel.id}`)).toBe(true);

		const { requestedModels } = await runPrimaryFailure("429 usage_limit_reached retry-after-ms=11180001");

		// The primary fails with a usage limit. The chain's only candidate is
		// suppressed, but no same-model retry is possible in the delay cap, so the
		// walk must still use it instead of ending the turn with no switch.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session?.model?.id).toBe(fallbackModel.id);
	});

	it("a transport error does not write a selector cooldown", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled test models to exist");

		const { requestedModels } = await runPrimaryFailure(TRANSPORT_ERROR);

		expect(requestedModels[0]).toBe(`${primaryModel.provider}/${primaryModel.id}`);
		expect(modelRegistry.isSelectorSuppressed(`${primaryModel.provider}/${primaryModel.id}`)).toBe(false);
	});

	it("a socket-closed transport error does not write a selector cooldown", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel) throw new Error("Expected bundled test models to exist");

		await runPrimaryFailure(SOCKET_CLOSED);

		expect(modelRegistry.isSelectorSuppressed(`${primaryModel.provider}/${primaryModel.id}`)).toBe(false);
	});

	it("a usage-limit failure still writes a selector cooldown", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel) throw new Error("Expected bundled test models to exist");

		await runPrimaryFailure(USAGE_LIMIT);

		expect(modelRegistry.isSelectorSuppressed(`${primaryModel.provider}/${primaryModel.id}`)).toBe(true);
	});

	it("a 429 rate limit still writes a selector cooldown", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel) throw new Error("Expected bundled test models to exist");

		await runPrimaryFailure("429 rate limit exceeded retry-after-ms=200");

		expect(modelRegistry.isSelectorSuppressed(`${primaryModel.provider}/${primaryModel.id}`)).toBe(true);
	});

	it("a 503 capacity error still writes a selector cooldown", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel) throw new Error("Expected bundled test models to exist");

		await runPrimaryFailure("503 service unavailable: model is overloaded, at capacity");

		expect(modelRegistry.isSelectorSuppressed(`${primaryModel.provider}/${primaryModel.id}`)).toBe(true);
	});

	it("a sibling's socket-closed failure on the candidate does not block the parent's usage-limit fallback", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled test models to exist");
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });

		// Sibling: runs the candidate as its primary and fails on the socket. Its
		// failure is a transport error, so it must not leave a cooldown behind.
		const siblingAgent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: fallbackModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				const mock = createMockModel();
				mock.push({ throw: SOCKET_CLOSED });
				return mock.stream(model, context, options);
			},
		});
		const siblingSettings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 5 });
		siblingSettings.setModelRole("default", `${fallbackModel.provider}/${fallbackModel.id}`);
		const sibling = new AgentSession({
			agent: siblingAgent,
			sessionManager: SessionManager.inMemory(),
			settings: siblingSettings,
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		await sibling.prompt("sibling run");
		await sibling.waitForIdle();
		await sibling.dispose();

		expect(modelRegistry.isSelectorSuppressed(`${fallbackModel.provider}/${fallbackModel.id}`)).toBe(false);

		// Parent: a usage limit on its primary. The candidate is now free, so the
		// walk switches to it.
		const { requestedModels } = await runPrimaryFailure(USAGE_LIMIT, true);
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});
});
