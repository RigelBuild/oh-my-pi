import { expect, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "../helpers";
import { captureLogs, secret } from "./capture";

withOfficialAnthropicEndpoint();
for (const mode of ["cache", "strict", "fast", "malformed", "healthy"] as const)
	test(`Anthropic ${mode} lifecycle emits no provider payload`, async () => {
		const capture = await captureLogs();
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		await storage.credentials.set("anthropic", [{ type: "api_key", key: secret.apiA }]);
		const model = buildModel({
			id: "claude-sonnet-4-6",
			name: "claude",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		let calls = 0;
		const bodies: string[] = [];
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => model,
			fetch: async (_input, init) => {
				calls++;
				bodies.push(String(init?.body));
				if ((mode === "cache" && calls <= 2) || ((mode === "strict" || mode === "fast") && calls === 1)) {
					const reason =
						mode === "cache"
							? "messages.0.content.0.cache_control: Extra inputs are not permitted"
							: mode === "strict"
								? "compiled grammar is too large"
								: "model does not support the speed parameter";
					return Response.json(
						{ error: { type: "invalid_request_error", message: `${reason} ${secret.error}` } },
						{ status: 400 },
					);
				}
				const events = [
					{ type: "message_start", message: { id: "synthetic", usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: secret.response } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				const malformed =
					mode === "malformed" ? `event: content_block_delta\ndata: {"private":"${secret.response}"\n\n` : "";
				return new Response(
					malformed + events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream", "x-private": secret.header } },
				);
			},
		});
		try {
			const response = await router.route(
				new Request("http://gateway/v1/pi/stream", {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${secret.inbound}` },
					body: JSON.stringify({
						modelId: model.id,
						context: {
							systemPrompt: [secret.request],
							messages: [{ role: "user", content: secret.request, timestamp: 0 }],
							tools: [{ name: "find", description: "find", parameters: { type: "object", properties: {} } }],
						},
						options: { cacheRetention: "long", serviceTier: mode === "fast" ? "priority" : undefined },
						stream: false,
					}),
				}),
				"peer",
				{ kind: "agent", agentAccountId: "pool" },
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(secret.response);
			expect(calls).toBe(mode === "cache" ? 3 : mode === "strict" || mode === "fast" ? 2 : 1);
			const expected =
				mode === "cache"
					? [
							"anthropic: endpoint rejected cache_control, retrying with breakpoints but no ttl/scope",
							"anthropic: endpoint rejected cache_control, retrying without prompt-cache breakpoints",
						]
					: mode === "strict"
						? ["anthropic: strict tools rejected, retrying without strict tools"]
						: mode === "fast"
							? ["anthropic: fast mode unsupported, retrying without speed"]
							: [];
			for (const message of expected) expect(capture.matching(message)).toHaveLength(1);
			const anomalies = capture.events.filter(event =>
				event.message.startsWith("anthropic: ignoring malformed stream envelope"),
			);
			expect(anomalies.length).toBe(mode === "malformed" ? 1 : 0);
			if (mode === "cache") {
				expect(bodies[0]).toContain('"ttl":"1h"');
				expect(bodies[1]).toContain('"cache_control"');
				expect(bodies[1]).not.toContain('"ttl"');
				expect(bodies[2]).not.toContain('"cache_control"');
			}
			await capture.assertSafe();
		} finally {
			router.close();
			storage.close();
			await capture.close();
		}
	});
