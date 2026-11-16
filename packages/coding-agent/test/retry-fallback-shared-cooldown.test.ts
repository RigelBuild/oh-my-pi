import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as resolveModule from "@oh-my-pi/pi-catalog/compat/resolve";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
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

	// Each row: the message a primary fails with, and whether that failure must cool it.
	const COOLDOWN_TABLE: Array<[label: string, message: string, cools: boolean]> = [
		[
			"Envoy 503 with proxy wording and an overflow reset reason",
			"503 upstream connect error or disconnect/reset before headers. reset reason: overflow",
			true,
		],
		["a bare connection error", "Connection error.", false],
		["a request timeout", "Request timed out.", false],
		[
			"a Kimi 403 monthly usage limit (access_terminated_error)",
			'403 {"error":{"message":"You have reached your monthly usage limit","type":"access_terminated_error"}}',
			true,
		],
		["a socket hang up that reports a byte count, with no status", "socket hang up after 512 bytes", false],
	];
	for (const [label, message, cools] of COOLDOWN_TABLE) {
		it(`${cools ? "cools" : "does not cool"} on ${label}`, async () => {
			const primaryModel = getBundledModel("openai", "gpt-4o");
			if (!primaryModel) throw new Error("Expected bundled test models to exist");
			await runPrimaryFailure(message);
			expect(modelRegistry.isSelectorSuppressed(`${primaryModel.provider}/${primaryModel.id}`)).toBe(cools);
		});
	}

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

/**
 * Walk-level cases. Each runs one prompt through a chain map and a per-model failure
 * script, and records every request. A request cap stops an unbounded walk, so a loop
 * fails the assertion instead of hanging the suite.
 */
describe("fallback walk bounds and candidate gating", () => {
	const REQUEST_CAP = 12;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-walk-bounds-");
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
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		vi.restoreAllMocks();
	});

	/**
	 * Run one prompt on `primary`. `failures` maps a model selector to the error it throws on
	 * every request; a model absent from it answers. `chains` is the default fallback chain.
	 */
	async function runWalk(options: {
		primary: string;
		chainMap: Record<string, string[]>;
		failures: Record<string, string>;
		withoutKey?: string[];
		cooled?: string[];
	}) {
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		for (const selector of options.cooled ?? []) {
			modelRegistry.suppressSelector(selector, Date.now() + 5 * 60 * 1000);
		}
		const [primaryProvider, ...primaryRest] = options.primary.split("/");
		const primaryModel = getBundledModel(primaryProvider, primaryRest.join("/"));
		if (!primaryModel) throw new Error(`Expected bundled model ${options.primary}`);
		for (const selector of options.withoutKey ?? []) {
			modelRegistry.authStorage.keys.removeRuntime(selector.split("/")[0]);
		}

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => {
				const selector = `${model.provider}/${model.id}`;
				return options.withoutKey?.includes(selector) ? undefined : `${model.provider}-test-key`;
			},
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, streamOptions) => {
				const selector = `${model.provider}/${model.id}`;
				requestedModels.push(selector);
				const mock = createMockModel();
				if (requestedModels.length > REQUEST_CAP) {
					mock.push({ throw: "request cap reached: the walk did not end" });
				} else if (options.failures[selector] !== undefined) {
					mock.push({ throw: options.failures[selector] });
				} else {
					mock.push({ content: [`ok:${selector}`] });
				}
				return mock.stream(model, context, streamOptions);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.fallbackChains": options.chainMap,
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		mockSchedulerWaitWithClock();
		await session.prompt("walk");
		await session.waitForIdle();
		return { requestedModels };
	}

	it("ends a mutual chain on a transport error after a bounded number of requests", async () => {
		const a = "openai/gpt-4o";
		const b = "anthropic/claude-sonnet-4-5";
		const { requestedModels } = await runWalk({
			primary: a,
			chainMap: { [a]: [b], [b]: [a] },
			failures: { [a]: TRANSPORT_ERROR, [b]: TRANSPORT_ERROR },
		});
		expect(requestedModels.length).toBeLessThanOrEqual(REQUEST_CAP);
		// The walk never switches back to the origin, so `a` is requested once. Requests to
		// `b` are same-model retries, which `retry.maxRetries` (default 10) bounds.
		expect(requestedModels.filter(selector => selector === a).length).toBe(1);
		expect(requestedModels.filter(selector => selector === b).length).toBeLessThanOrEqual(10);
	});

	it("ends a mutual chain on a long usage limit after a bounded number of requests", async () => {
		const a = "openai/gpt-4o";
		const b = "anthropic/claude-sonnet-4-5";
		const longLimit = "429 usage_limit_reached retry-after-ms=11180001";
		const { requestedModels } = await runWalk({
			primary: a,
			chainMap: { [a]: [b], [b]: [a] },
			failures: { [a]: longLimit, [b]: longLimit },
		});
		expect(requestedModels.length).toBeLessThanOrEqual(REQUEST_CAP);
		expect(requestedModels.filter(selector => selector === a).length).toBe(1);
		expect(requestedModels.filter(selector => selector === b).length).toBe(1);
	});

	it("ends a mutual chain of two long-limit providers after a bounded number of requests", async () => {
		const a = "openai/gpt-4o";
		const b = "anthropic/claude-sonnet-4-5";
		const longLimit = "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=11180001";
		// Both providers carry the long-limit flag, so each long limit wraps around to the other.
		const real = resolveModelPolicy;
		const flagged = vi.spyOn(resolveModule, "resolveModelPolicy").mockImplementation((spec, route) => {
			const policy = real(spec, route);
			return { ...policy, catalog: { ...policy.catalog, longUsageLimitFallback: true } } as typeof policy;
		});
		try {
			const { requestedModels } = await runWalk({
				primary: a,
				chainMap: { [a]: [b], [b]: [a] },
				failures: { [a]: longLimit, [b]: longLimit },
			});
			// Each provider is requested once: its long limit cools it, so the wrap back is blocked.
			expect(requestedModels).toEqual([a, b]);
		} finally {
			flagged.mockRestore();
		}
	});

	it("does not loop when the origin fails transport and a flagged peer wraps back to it", async () => {
		const a = "openai/gpt-4o";
		const b = "anthropic/claude-sonnet-4-5";
		const longLimit = "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=11180001";
		const real = resolveModelPolicy;
		const flagged = vi.spyOn(resolveModule, "resolveModelPolicy").mockImplementation((spec, route) => {
			const policy = real(spec, route);
			return { ...policy, catalog: { ...policy.catalog, longUsageLimitFallback: true } } as typeof policy;
		});
		try {
			const { requestedModels } = await runWalk({
				primary: a,
				chainMap: { [a]: [b], [b]: [a] },
				failures: { [a]: TRANSPORT_ERROR, [b]: longLimit },
			});
			// Hops: origin A, peer B, then A four times. The uncooled origin is revisited by the
			// peer's wrap. Its same-model retries stop once the backoff passes `retry.maxDelayMs`
			// (100 in runWalk), so the cap, not `retry.maxRetries`, bounds the count. The walk ends.
			expect(requestedModels).toEqual([a, b, a, a, a, a]);
		} finally {
			flagged.mockRestore();
		}
	});

	it("uses a cooled candidate after an earlier cooled candidate has no key", async () => {
		const primary = "openai/gpt-4o";
		const noKey = "anthropic/claude-sonnet-4-5";
		const usable = "openai/gpt-5";
		const { requestedModels } = await runWalk({
			primary,
			chainMap: { [primary]: [noKey, usable] },
			failures: { [primary]: USAGE_LIMIT },
			withoutKey: [noKey],
			cooled: [noKey, usable],
		});
		expect(requestedModels).toEqual([primary, usable]);
	});

	it("switches to a cooled candidate when an uncooled candidate has no auth", async () => {
		const primary = "openai/gpt-4o";
		const noAuth = "anthropic/claude-sonnet-4-5";
		const cooledUsable = "openai/gpt-5";
		const { requestedModels } = await runWalk({
			primary,
			chainMap: { [primary]: [noAuth, cooledUsable] },
			failures: { [primary]: USAGE_LIMIT },
			withoutKey: [noAuth],
			cooled: [cooledUsable],
		});
		expect(requestedModels).toEqual([primary, cooledUsable]);
	});
});
