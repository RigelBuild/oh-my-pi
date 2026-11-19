import { expect, spyOn, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { gatewayLogContext, logGatewayProviderResponse } from "@oh-my-pi/pi-ai/auth-gateway/logging";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { captureLogs, secret } from "./capture";

test("credential selection logs at info while per-request detail logs at debug", async () => {
	registerMockApi();
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storage.keys.setRuntime("mock", secret.apiA);
	const model = createMockModel({
		handler: { content: [secret.response], responseHeaders: { "x-a": "1" }, responseStatus: 200 },
	});
	const router = createAuthGatewayRouter({ storage, resolveModel: () => model });
	try {
		const response = await router.route(
			new Request("http://gateway/v1/chat/completions", {
				method: "POST",
				headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					messages: [{ role: "user", content: secret.request }],
					stream: false,
				}),
			}),
			"peer",
			{ kind: "agent", agentAccountId: "pool" },
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(secret.response);
		const selected = capture.matching("auth-gateway credential selected");
		expect(selected).toHaveLength(1);
		expect(selected[0]?.level).toBe("info");
		const requests = capture.matching("auth-gateway request");
		expect(requests.length).toBeGreaterThan(0);
		for (const event of requests) expect(event.level).toBe("debug");
		const responses = capture.matching("auth-gateway provider response");
		expect(responses.length).toBeGreaterThan(0);
		for (const event of responses) expect(event.level).toBe("debug");
		await capture.assertSafe();
	} finally {
		router.close();
		storage.close();
		await capture.close();
	}
});

test("quota observations and provider responses log at info for non-2xx and debug for 2xx", async () => {
	const capture = await captureLogs();
	try {
		const headers = {
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1900000000",
		};
		const caller = { kind: "agent", agentAccountId: "pool" } as const;
		logGatewayProviderResponse(gatewayLogContext("request-429", caller, "format", "openai-codex", "model"), {
			status: 429,
			credentialId: 3,
			headers,
		});
		logGatewayProviderResponse(gatewayLogContext("request-200", caller, "format", "openai-codex", "model"), {
			status: 200,
			credentialId: 3,
			headers,
		});
		const failed = capture.events.filter(event => event.context?.requestId === "request-429");
		const succeeded = capture.events.filter(event => event.context?.requestId === "request-200");
		expect(failed.map(event => [event.message, event.level])).toEqual([
			["auth-gateway provider response", "info"],
			["auth-gateway quota observation", "info"],
		]);
		expect(succeeded.map(event => [event.message, event.level])).toEqual([
			["auth-gateway provider response", "debug"],
			["auth-gateway quota observation", "debug"],
		]);
		await capture.assertSafe();
	} finally {
		await capture.close();
	}
});

test("video submit request line logs at debug", async () => {
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const get = spyOn(storage.keys, "getWithCredential").mockResolvedValue({ apiKey: secret.apiA, credentialId: 11 });
	const model = buildModel({
		id: "google/veo-3.1",
		name: "video",
		provider: "openrouter",
		api: "openrouter-video",
		kind: "video",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	});
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: () => model,
		fetch: async () => {
			throw new ProviderHttpError(`bad request ${secret.error}`, 400);
		},
	});
	try {
		const response = await router.route(
			new Request("http://gateway/v1/videos", {
				method: "POST",
				headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
				body: JSON.stringify({ model: model.id, prompt: secret.request }),
			}),
			"peer",
			{ kind: "agent", agentAccountId: "agent", ownerUserId: "pool" },
		);
		await response.text();
		const requests = capture.matching("auth-gateway request");
		expect(requests.length).toBeGreaterThan(0);
		for (const event of requests) expect(event.level).toBe("debug");
		await capture.assertSafe();
	} finally {
		await router.close();
		get.mockRestore();
		storage.close();
		await capture.close();
	}
});
