import { expect, spyOn, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import * as video from "@oh-my-pi/pi-ai/video";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { captureLogs, secret } from "./capture";

for (const operation of ["submit", "poll", "content"] as const) {
	for (const runtime of [false, true]) {
		for (const rotateBack of [false, true]) {
			for (const terminalStatus of [429, 400]) {
				test(`video ${operation} attributes failed attempt, runtime=${runtime}, status=${terminalStatus}, rotateBack=${rotateBack}`, async () => {
					const capture = await captureLogs();
					const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
					const a = { apiKey: secret.apiA, credentialId: runtime ? 21 : 11 };
					const b = { apiKey: secret.apiB, credentialId: runtime ? 22 : 12 };
					const get = spyOn(storage.keys, "getWithCredential")
						.mockResolvedValueOnce(a)
						.mockResolvedValueOnce(b)
						// The retry driver permits a previously sent bearer only after a sibling wait.
						.mockResolvedValueOnce(rotateBack ? { ...a, afterSiblingWait: true } : a)
						.mockResolvedValue(a);
					const reached = spyOn(storage.limits, "markReached").mockResolvedValue({ switched: true });
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
					const sent: string[] = [];
					const router = createAuthGatewayRouter({
						storage,
						resolveModel: () => model,
						fetch: async (_input, init) => {
							sent.push(new Headers(init?.headers).get("authorization") ?? "");
							throw new ProviderHttpError(
								sent.length > (rotateBack ? 2 : 1) && terminalStatus === 400
									? `bad request ${secret.error}`
									: `usage limit reached ${secret.error}`,
								sent.length <= (rotateBack ? 2 : 1) ? 429 : terminalStatus,
							);
						},
					});
					try {
						const id = encodeGatewayJobId({ provider: model.provider, modelId: model.id, upstreamId: "job" });
						const path =
							operation === "submit"
								? "/v1/videos"
								: `/v1/videos/${id}${operation === "content" ? "/content" : ""}`;
						const response = await router.route(
							new Request(`http://gateway${path}`, {
								method: operation === "submit" ? "POST" : "GET",
								headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
								...(operation === "submit"
									? { body: JSON.stringify({ model: model.id, prompt: secret.request }) }
									: {}),
							}),
							"peer",
							{ kind: "agent", agentAccountId: "agent", ownerUserId: "pool" },
						);
						expect(response.status).toBe(terminalStatus);
						await response.text();
						expect(sent).toEqual([
							`Bearer ${secret.apiA}`,
							`Bearer ${secret.apiB}`,
							...(rotateBack ? [`Bearer ${secret.apiA}`] : []),
						]);
						const terminal = capture.matching("auth-gateway request failed");
						expect(terminal).toHaveLength(1);
						expect(terminal[0]?.context).toMatchObject({
							format: `video-${operation}`,
							pool: "pool",
							status: terminalStatus,
						});
						expect(terminal[0]?.context?.credentialId).toBe(rotateBack ? a.credentialId : b.credentialId);
						expect(terminal[0]?.context?.requestId).toBe(
							capture.matching("auth-gateway credential selected")[0]?.context?.requestId,
						);
						await capture.assertSafe();
					} finally {
						await router.close();
						get.mockRestore();
						reached.mockRestore();
						storage.close();
						await capture.close();
					}
				});
			}
		}
	}
}

for (const scenario of ["pre-send", "missing", "non-bearer", "unknown", "ambiguous"] as const) {
	test(`video sent credential tracking handles ${scenario} authorization`, async () => {
		const capture = await captureLogs();
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		const initial = { apiKey: secret.apiA, credentialId: 11 };
		const get = spyOn(storage.keys, "getWithCredential")
			.mockResolvedValueOnce(initial)
			.mockResolvedValue({ apiKey: secret.apiA, credentialId: 12 });
		const reached = spyOn(storage.limits, "markReached").mockResolvedValue({ switched: true });
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
		const submit = spyOn(video, "submitVideo").mockImplementation(async (_model, _request, options) => {
			if (typeof options.apiKey !== "function" || !options.fetch) throw new Error("expected wrapped transport");
			if (scenario === "pre-send") throw new ProviderHttpError("bad request", 400);
			const initialKey = await options.apiKey({ lastChance: false, error: undefined });
			if (typeof initialKey !== "object" || !initialKey) throw new Error("expected initial credential");
			await options.fetch("https://example.test", { headers: { authorization: `Bearer ${initialKey.apiKey}` } });
			if (scenario === "ambiguous") {
				await options.apiKey({
					lastChance: true,
					error: new ProviderHttpError("usage limit reached", 429),
					previousKey: initialKey.apiKey,
				});
				await options.fetch("https://example.test", { headers: { authorization: `Bearer ${initialKey.apiKey}` } });
			} else {
				const headers = new Headers();
				if (scenario !== "missing")
					headers.set("authorization", scenario === "non-bearer" ? "Basic ignored" : "Bearer unknown");
				await options.fetch("https://example.test", { headers });
			}
			throw new ProviderHttpError("bad request", 400);
		});
		const router = createAuthGatewayRouter({ storage, resolveModel: () => model, fetch: async () => new Response() });
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
			expect(response.status).toBe(400);
			const terminal = capture.matching("auth-gateway request failed");
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.context?.credentialId).toBe(
				scenario === "ambiguous" || scenario === "pre-send" ? undefined : 11,
			);
			await capture.assertSafe();
		} finally {
			await router.close();
			submit.mockRestore();
			get.mockRestore();
			reached.mockRestore();
			storage.close();
			await capture.close();
		}
	});
}
