import { expect, spyOn, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { captureLogs, secret } from "./capture";

for (const operation of ["submit", "poll", "content"] as const) {
	for (const runtime of [false, true]) {
		for (const terminalStatus of [429, 400]) {
			test(`video ${operation} attributes A to B to rejected A to failed B, runtime=${runtime}, status=${terminalStatus}`, async () => {
				const capture = await captureLogs();
				const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
				const a = { apiKey: secret.apiA, credentialId: runtime ? undefined : 11 };
				const b = { apiKey: secret.apiB, credentialId: runtime ? undefined : 12 };
				const get = spyOn(storage.keys, "getWithCredential")
					.mockResolvedValueOnce(a)
					.mockResolvedValueOnce(b)
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
							`usage limit reached ${secret.error}`,
							sent.length === 1 ? 429 : terminalStatus,
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
					expect(sent).toEqual([`Bearer ${secret.apiA}`, `Bearer ${secret.apiB}`]);
					const terminal = capture.matching("auth-gateway request failed");
					expect(terminal).toHaveLength(1);
					expect(terminal[0]?.context).toMatchObject({
						format: `video-${operation}`,
						pool: "pool",
						status: terminalStatus,
					});
					expect(terminal[0]?.context?.credentialId).toBe(b.credentialId);
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
