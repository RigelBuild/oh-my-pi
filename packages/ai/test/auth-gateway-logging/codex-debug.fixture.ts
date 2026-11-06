import { expect, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createCodexModel } from "../helpers";
import { captureLogs, secret } from "./capture";

for (const steered of [false, true])
	test(`Codex SSE projects safe diagnostics and steering=${steered}`, async () => {
		const capture = await captureLogs();
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.bbb`;
		await storage.credentials.set("openai-codex", [{ type: "api_key", key: token }]);
		const model = createCodexModel("gpt-5.5");
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => model,
			fetch: async () => {
				const events = [
					{
						type: "response.output_item.added",
						item: { type: "message", id: "synthetic", role: "assistant", content: [] },
					},
					{ type: "response.output_text.delta", delta: secret.response },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "synthetic",
							role: "assistant",
							content: [{ type: "output_text", text: secret.response }],
						},
					},
					{
						type: steered ? "response.incomplete" : "response.completed",
						response: {
							id: secret.raw,
							status: steered ? "incomplete" : "completed",
							...(steered ? { incomplete_details: { reason: "steered" } } : {}),
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					},
				];
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream", "x-private": secret.header },
				});
			},
		});
		try {
			const response = await router.route(
				new Request("http://gateway/v1/pi/stream", {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${secret.inbound}` },
					body: JSON.stringify({
						modelId: model.id,
						context: { messages: [{ role: "user", content: secret.request, timestamp: 0 }] },
						options: {
							preferWebsockets: false,
							promptCacheKey: secret.metadata,
							sessionId: secret.captured,
							headers: { "x-private": secret.header },
						},
						stream: false,
					}),
				}),
				"peer",
				{ kind: "agent", agentAccountId: "pool" },
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(secret.response);
			expect(capture.matching("Codex response stopped for steering").map(event => event.context)).toEqual(
				steered ? [{ responseIdPresent: true }] : [],
			);
			for (const message of ["[codex] codex turn request diagnostics", "[codex] codex turn diagnostics"]) {
				const events = capture.matching(message);
				expect(events).toHaveLength(process.env.PI_CODEX_DEBUG === "1" ? 1 : 0);
				for (const event of events) {
					expect(event.context).not.toHaveProperty("promptCacheKey");
					expect(event.context).not.toHaveProperty("optionsHash");
					expect(event.context).not.toHaveProperty("toolsHash");
					expect(event.context).not.toHaveProperty("diagnostics");
				}
			}
			await capture.assertSafe([token]);
		} finally {
			router.close();
			storage.close();
			await capture.close();
		}
	});
