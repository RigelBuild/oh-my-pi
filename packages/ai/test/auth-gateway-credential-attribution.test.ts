import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthGatewayRouteOptions,
	bearerTokenAuthorizer,
	createAuthGatewayRouter,
	type GatewayUsageEvent,
	recordGatewayUsage,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockHandler, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import type { ObservedAttemptOutcome, ObservedLimitObservation } from "@oh-my-pi/pi-ai/usage";

const usage: Usage = {
	input: 12,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 16,
	cost: { input: 0.12, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.16 },
};
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const RATE_LIMIT_HEADERS = {
	"anthropic-ratelimit-requests-limit": "50",
	"anthropic-ratelimit-requests-remaining": "45",
	"anthropic-ratelimit-input-tokens-limit": "1000",
	"anthropic-ratelimit-input-tokens-remaining": "900",
};

interface Harness {
	url: string;
	storage: AuthStorage;
	handle: AuthGatewayServerHandle;
	dir: string;
	model: MockModel;
	events: GatewayUsageEvent[];
	ids: Map<string, number>;
	observed: Array<{ credentialId?: number; outcome?: string }>;
	outcomes: ObservedAttemptOutcome[];
	limits: ObservedLimitObservation[];
}

async function boot(options: {
	provider: string;
	modelId?: string;
	keys?: readonly string[];
	handler?: MockHandler;
	apiKeyLimitModelClasses?: Record<string, string>;
}): Promise<Harness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-credential-attribution-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	if (options.keys) {
		await storage.credentials.set(
			options.provider,
			options.keys.map(key => ({ type: "api_key", key })),
		);
	}
	const ids = new Map<string, number>();
	for (const row of storage.credentials.list(options.provider)) {
		if (row.credential.type === "api_key") ids.set(row.credential.key, row.id);
	}
	const model = createMockModel({
		provider: options.provider,
		id: options.modelId ?? "attribution-model",
		...(options.handler && { handler: options.handler }),
	});
	const observed: Harness["observed"] = [];
	const outcomes: ObservedAttemptOutcome[] = [];
	const limits: ObservedLimitObservation[] = [];
	vi.spyOn(storage.usage, "observe").mockImplementation(entry => observed.push(entry));
	vi.spyOn(storage.usage, "observeOutcome").mockImplementation(outcome => outcomes.push(outcome));
	vi.spyOn(storage.usage, "observeLimits").mockImplementation(batch => limits.push(...batch));
	const events: GatewayUsageEvent[] = [];
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer(["test-token"]),
		storage,
		resolveModel: () => model,
		version: "test",
		onUsage: event => {
			events.push(event);
		},
		...(options.apiKeyLimitModelClasses && { apiKeyLimitModelClasses: options.apiKeyLimitModelClasses }),
	});
	return { url: handle.url, storage, handle, dir, model, events, ids, observed, outcomes, limits };
}

function chat(harness: Harness, stream = false): Promise<Response> {
	return fetch(`${harness.url}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify({ model: harness.model.id, messages: [{ role: "user", content: "hello" }], stream }),
	});
}

/** First call fails with `firstError`; every later call answers with `then`. */
function failFirst(firstError: Error, then: MockHandler): MockHandler {
	let calls = 0;
	return (context, options) => {
		if (calls++ === 0) throw firstError;
		return typeof then === "function" ? then(context, options) : then;
	};
}

describe("auth-gateway credential attribution", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (harness) {
			await harness.handle.close();
			harness.storage.close();
			await fs.rm(harness.dir, { recursive: true, force: true });
		}
		harness = undefined;
	});

	it("attributes chat usage to the credential row that served the retried attempt", async () => {
		harness = await boot({
			provider: "mock",
			keys: ["key-one", "key-two"],
			handler: failFirst(new ProviderHttpError("expired credential", 401), { content: ["ok"], usage }),
		});
		const response = await chat(harness);
		expect(response.status).toBe(200);
		const second = harness.ids.get("key-two");
		expect(second).toBeNumber();
		expect(second).not.toBe(harness.ids.get("key-one"));
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]?.credentialId).toBe(second);
		expect(harness.observed).toEqual([expect.objectContaining({ credentialId: second, outcome: "ok" })]);
	});

	it("records a zero-usage provider error as an outcome, not a client usage entry", async () => {
		harness = await boot({ provider: "mock", keys: ["key-one"] });
		harness.model.push({ content: [], usage: zeroUsage, stopReason: "error", errorMessage: "upstream exploded" });
		const response = await chat(harness);
		expect(response.status).not.toBe(200);
		expect(harness.observed).toHaveLength(0);
		expect(harness.events).toHaveLength(0);
		expect(harness.outcomes).toEqual([
			expect.objectContaining({
				provider: "mock",
				model: harness.model.id,
				credentialId: harness.ids.get("key-one"),
				outcome: "error",
				requests: 1,
			}),
		]);
	});

	it("leaves a failure before credential selection unattributed", async () => {
		harness = await boot({ provider: "mock" });
		const response = await chat(harness);
		expect(response.status).toBe(401);
		expect(harness.model.calls).toHaveLength(0);
		expect(harness.outcomes).toHaveLength(0);
		expect(harness.observed).toHaveLength(0);
		// A zero-usage settle without a row identity is dropped, never folded into some row.
		const routeOptions: AuthGatewayRouteOptions = { storage: harness.storage, resolveModel: () => undefined };
		recordGatewayUsage(routeOptions, harness.model, { installId: "i-1" }, zeroUsage, {
			requestId: "r",
			outcome: "error",
		});
		expect(harness.outcomes).toHaveLength(0);
	});

	it("binds a mapped model's rate-limit headers to the attempt's row", async () => {
		harness = await boot({
			provider: "anthropic",
			modelId: "claude-opus-5-5",
			keys: ["sk-ant-api03-one", "sk-ant-api03-two"],
			apiKeyLimitModelClasses: { "claude-opus-5-5": "opus-5.5" },
			handler: failFirst(new ProviderHttpError("expired credential", 401), {
				content: ["ok"],
				usage,
				responseHeaders: RATE_LIMIT_HEADERS,
			}),
		});
		const response = await chat(harness);
		expect(response.status).toBe(200);
		expect(harness.limits).toHaveLength(1);
		const [observation] = harness.limits;
		expect(observation).toMatchObject({
			provider: "anthropic",
			credentialId: harness.ids.get("sk-ant-api03-two"),
			modelClass: "opus-5.5",
		});
		expect(observation?.limits.map(limit => limit.id)).toEqual([
			"anthropic:api:opus-5.5:requests",
			"anthropic:api:opus-5.5:input-tokens",
		]);
	});

	it("reports no limit observation for an unmapped model", async () => {
		harness = await boot({
			provider: "anthropic",
			modelId: "claude-opus-4-1",
			keys: ["sk-ant-api03-one"],
			apiKeyLimitModelClasses: { "claude-opus-5-5": "opus-5.5" },
		});
		harness.model.push({ content: ["ok"], usage, responseHeaders: RATE_LIMIT_HEADERS });
		const response = await chat(harness);
		expect(response.status).toBe(200);
		expect(harness.limits).toHaveLength(0);
	});

	it("rejects a model-class map with more than three distinct rows at boot", async () => {
		const storage = await AuthStorage.create(":memory:");
		try {
			expect(() =>
				createAuthGatewayRouter({
					storage,
					resolveModel: () => undefined,
					apiKeyLimitModelClasses: { a: "row-1", b: "row-2", c: "row-3", d: "row-4" },
				}),
			).toThrow(/at most 3/);
			expect(() =>
				createAuthGatewayRouter({
					storage,
					resolveModel: () => undefined,
					apiKeyLimitModelClasses: { a: "row-1", b: "row-2", c: "row-3", d: "row-3" },
				}).close(),
			).not.toThrow();
		} finally {
			storage.close();
		}
	});

	it("records credit exhaustion on the exact row that returned it", async () => {
		harness = await boot({
			provider: "anthropic",
			modelId: "claude-opus-5-5",
			keys: ["sk-ant-api03-one", "sk-ant-api03-two"],
			handler: failFirst(
				new ProviderHttpError("Your credit balance is too low to access the Anthropic API.", 400),
				{ content: ["ok"], usage },
			),
		});
		const response = await chat(harness);
		expect(response.status).toBe(200);
		expect(harness.limits).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				credentialId: harness.ids.get("sk-ant-api03-one"),
				limits: [],
				error: "credit_exhausted",
			}),
		]);
		expect(harness.events[0]?.credentialId).toBe(harness.ids.get("sk-ant-api03-two"));
	});
});
