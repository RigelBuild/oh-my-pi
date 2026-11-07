import { expect, spyOn, test } from "bun:test";
import { createAuthGatewayRouter, type AuthGatewayRouteOptions } from "@oh-my-pi/pi-ai/auth-gateway";
import { emitGatewayUsage } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";
import { createCodexModel, withOfficialAnthropicEndpoint } from "../helpers";
import { resolveProviderModelReference } from "../../../coding-agent/src/config/model-resolver";
import { captureLogs, secret } from "./capture";

withOfficialAnthropicEndpoint();
const caller = { kind: "agent", agentAccountId: "agent", ownerUserId: "admitted-pool" } as const;
function request(route: string, body: unknown): Request {
	return new Request(`http://gateway${route}`, {
		method: "POST",
		headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
function chat() {
	return { model: "requested-alias", messages: [{ role: "user", content: secret.request }], stream: false };
}

for (const piNative of [false, true]) {
	test(`captures complete ${piNative ? "pi-native" : "format"} success, rotation, terminal and rejected hooks without secrets`, async () => {
		registerMockApi();
		const capture = await captureLogs();
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		await storage.credentials.set("mock", [
			{ type: "api_key", key: secret.apiA },
			{ type: "api_key", key: secret.apiB },
		]);
		const ids = storage.credentials.list("mock").map(row => row.id);
		const onUsage = spyOn(
			{
				run: async () => {
					throw new Error(secret.cause);
				},
			},
			"run",
		);
		const recovery = spyOn(
			{
				run: async () => {
					throw Object.assign(new Error(secret.error), { stack: secret.stack, cause: new Error(secret.cause) });
				},
			},
			"run",
		);
		let calls = 0;
		let terminal = false;
		const model = createMockModel({
			id: "resolved-model",
			handler: () => {
				if (terminal) return { content: [], stopReason: "error", errorMessage: secret.error };
				if (calls++ === 0)
					throw Object.assign(new ProviderHttpError(`usage limit reached ${secret.error}`, 429), {
						headers: { "retry-after": "0", "x-private": secret.header },
						info: { raw: secret.raw },
						capturedBody: secret.captured,
					});
				return {
					content: [secret.response],
					usage: { input: 1, output: 1, cost: { total: 0.1 } },
					responseHeaders: { "x-private": secret.header },
				};
			},
		});
		const router = createAuthGatewayRouter({ storage, resolveModel: () => model, onUsage, onUsageLimit: recovery });
		const send = () =>
			router.route(
				request(
					piNative ? "/v1/pi/stream" : "/v1/chat/completions",
					piNative
						? {
								modelId: "alias",
								context: { messages: [{ role: "user", content: secret.request, timestamp: 0 }] },
								stream: false,
							}
						: chat(),
				),
				"peer",
				caller,
			);
		try {
			const response = await send();
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(secret.response);
			await Promise.resolve();
			expect(recovery).toHaveBeenCalledTimes(1);
			expect(onUsage).toHaveBeenCalledTimes(1);
			expect(capture.matching("auth-gateway usage-limit recovery failed")[0]?.context).toMatchObject({
				pool: "admitted-pool",
				credentialId: ids[0],
			});
			expect(capture.matching("auth-gateway provider attempt failed")[0]?.context).toMatchObject({
				pool: "admitted-pool",
				credentialId: ids[0],
				status: 429,
			});
			expect(capture.matching("auth-gateway provider response").at(-1)?.context).toMatchObject({
				credentialId: ids[1],
				status: 200,
				model: "resolved-model",
			});
			const requestId = capture.matching("auth-gateway credential selected")[0]?.context?.requestId;
			expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
			terminal = true;
			const failed = await send();
			expect(failed.status).not.toBe(200);
			await failed.text();
			expect(capture.matching("auth-gateway request failed").length).toBeGreaterThan(0);
			expect(capture.events.some(event => event.message === "auth-gateway onUsage hook failed")).toBe(true);
			await capture.assertSafe();
		} finally {
			await router.close();
			storage.close();
			onUsage.mockRestore();
			recovery.mockRestore();
			await capture.close();
		}
	});
}

test("captures non-chat embeddings selection, A to B rotation and terminal error", async () => {
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await storage.credentials.set("openai", [
		{ type: "api_key", key: secret.apiA },
		{ type: "api_key", key: secret.apiB },
	]);
	const model = buildModel({
		id: "text-embedding-3-small",
		name: "embedding",
		api: "openai-embeddings",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: null,
		kind: "embedding",
		supportsTools: false,
	});
	let terminal = false;
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: () => model,
		fetch: async (_input, init) => {
			if (terminal) throw new ProviderHttpError(secret.error, 400);
			if (new Headers(init?.headers).get("authorization") === `Bearer ${secret.apiA}`)
				throw new ProviderHttpError(`usage limit reached ${secret.error}`, 429);
			return Response.json({
				object: "list",
				data: [{ object: "embedding", index: 0, embedding: [0.5] }],
				model: model.id,
				usage: { prompt_tokens: 1, total_tokens: 1 },
				extra: secret.response,
			});
		},
	});
	try {
		const response = await router.route(
			request("/v1/embeddings", { model: "alias", input: secret.request }),
			"peer",
			caller,
		);
		expect(response.status).toBe(200);
		await response.text();
		expect(capture.matching("auth-gateway credential selected")).toHaveLength(2);
		expect(capture.matching("auth-gateway provider attempt failed")[0]?.context?.pool).toBe("admitted-pool");
		terminal = true;
		const failed = await router.route(
			request("/v1/embeddings", { model: "alias", input: secret.request }),
			"peer",
			caller,
		);
		expect(failed.status).toBe(400);
		await failed.text();
		expect(capture.matching("auth-gateway request failed")).toHaveLength(1);
		await capture.assertSafe();
	} finally {
		await router.close();
		storage.close();
		await capture.close();
	}
});

for (const provider of ["anthropic", "openai-codex"] as const) {
	test(`${provider} failed HTTP acquisition exposes exact observed 429 headers before error reconstruction`, async () => {
		const capture = await captureLogs();
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		const token =
			provider === "anthropic"
				? secret.apiA
				: `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.bbb`;
		await storage.credentials.set(provider, [{ type: "api_key", key: token }]);
		const model =
			provider === "openai-codex"
				? createCodexModel("gpt-5.5")
				: buildModel({
						id: "claude-sonnet-4-5",
						name: "claude",
						api: "anthropic-messages",
						provider,
						baseUrl: "https://api.anthropic.com",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000,
						maxTokens: 8192,
					});
		const observedLimits = spyOn(storage.usage, "observeLimits").mockImplementation(() => {});
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => model,
			apiKeyLimitModelClasses: { [model.id]: "sonnet-4.5" },
			fetch: async () =>
				Response.json(
					{
						error: {
							type: "rate_limit_error",
							code: "usage_limit_reached",
							message: `usage limit reached ${secret.error}`,
							raw: secret.raw,
							body: secret.captured,
						},
					},
					{
						status: 429,
						headers: {
							"retry-after-ms": "0",
							"x-private": secret.header,
							"x-should-retry": "false",
							"x-codex-primary-used-percent": "100",
							"x-codex-primary-window-minutes": "300",
							"x-codex-primary-reset-at": "1900000000",
							"anthropic-ratelimit-requests-limit": "50",
							"anthropic-ratelimit-requests-remaining": "0",
						},
					},
				),
		});
		try {
			const body = {
				modelId: model.id,
				context: { messages: [{ role: "user", content: secret.request, timestamp: 0 }] },
				stream: false,
				options: { preferWebsockets: false, codexSseMaxAttempts: 1, maxRetryDelayMs: 1 },
			};
			const response = await router.route(request("/v1/pi/stream", body), "peer", caller);
			expect(response.status).not.toBe(200);
			await response.text();
			const row = storage.credentials.list(provider)[0]?.id;
			expect(capture.matching("auth-gateway provider response")[0]?.context).toMatchObject({
				provider,
				status: 429,
				credentialId: row,
				pool: "admitted-pool",
				retryAfterMs: 0,
			});
			expect(capture.matching("auth-gateway quota observation")[0]?.context).toMatchObject({
				window: provider === "anthropic" ? "requests" : "primary",
				credentialId: row,
			});
			// The gateway filters the transport-only attempt override; Codex's six wire attempts are intentional.
			expect(
				capture
					.matching("auth-gateway provider response")
					.map(event => [event.context?.credentialId, event.context?.status]),
			).toEqual(Array.from({ length: provider === "openai-codex" ? 6 : 1 }, () => [row, 429]));
			const batches = observedLimits.mock.calls
				.flatMap(call => call[0])
				.filter(observation => observation.modelClass !== undefined);
			expect(
				batches.map(observation => [
					observation.credentialId,
					observation.modelClass,
					observation.limits.map(limit => [limit.window?.id, limit.amount.remaining]),
				]),
			).toEqual(provider === "anthropic" ? [[row, "sonnet-4.5", [["requests", 0]]]] : []);
			await capture.assertSafe([token]);
		} finally {
			observedLimits.mockRestore();
			router.close();
			storage.close();
			await capture.close();
		}
	});
}

test("synchronous usage-hook failures never serialize their Error or cause", async () => {
	const capture = await captureLogs();
	try {
		const storage = await AuthStorage.create(":memory:");
		try {
			const options: AuthGatewayRouteOptions = {
				storage,
				resolveModel: () => undefined,
				onUsage: () => {
					throw Object.assign(new Error(secret.error), { stack: secret.stack, cause: new Error(secret.cause) });
				},
			};
			emitGatewayUsage(options, {
				requestId: "request",
				provider: "mock",
				model: "model",
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				outcome: "ok",
				at: 0,
				client: { installId: "synthetic" },
			});
			logger.info("auth-gateway synthetic lifecycle captured");
			expect(capture.events.some(event => event.message === "auth-gateway onUsage hook failed")).toBe(true);
			await capture.assertSafe();
		} finally {
			storage.close();
		}
	} finally {
		await capture.close();
	}
});

test("resolved OpenRouter routing suffix never reaches gateway sinks", async () => {
	registerMockApi();
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storage.keys.setRuntime("openrouter", secret.apiA);
	const base = createMockModel({ provider: "openrouter", id: "vendor/model", handler: () => ({ content: ["ok"] }) });
	const selector = `vendor/model:${secret.metadata}`;
	const resolved = resolveProviderModelReference("openrouter", selector, [base]);
	expect(resolved?.id).toBe(selector);
	const router = createAuthGatewayRouter({ storage, resolveModel: () => resolved });
	try {
		const response = await router.route(
			request("/v1/chat/completions", { ...chat(), model: selector }),
			"peer",
			caller,
		);
		await response.text();
		const events = capture.matching("auth-gateway credential selected");
		expect(events.length).toBeGreaterThan(0);
		for (const event of events) expect(event.context?.model).toBe(base.id);
		for (const event of capture.events.filter(event =>
			/auth-gateway (credential selected|provider response|quota observation|provider attempt failed|request failed)/.test(
				event.message,
			),
		))
			expect(JSON.stringify(event)).not.toContain(secret.metadata);
	} finally {
		await router.close();
		storage.close();
		await capture.close();
	}
});
