import { expect, onTestFinished, spyOn, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import type { GatewayUsageEvent } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel, withOfficialAnthropicEndpoint } from "../helpers";
import { captureLogs, secret } from "./capture";

withOfficialAnthropicEndpoint();
function codexToken(account: string): string {
	return `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.bbb`;
}
function success(provider: "anthropic" | "openai-codex"): Response {
	const events =
		provider === "anthropic"
			? [
					{
						type: "message_start",
						message: {
							id: "synthetic-message",
							role: "assistant",
							model: "claude-sonnet-4-5",
							content: [],
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: secret.response } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]
			: [
					{
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "synthetic-message",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: secret.response },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "synthetic-message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: secret.response }],
						},
					},
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
	return new Response(
		events
			.map(event => `${provider === "anthropic" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{
			headers: {
				"content-type": "text/event-stream",
				"x-private": secret.header,
				"anthropic-ratelimit-requests-limit": "50",
				"anthropic-ratelimit-requests-remaining": "49",
			},
		},
	);
}

for (const provider of ["anthropic", "openai-codex"] as const) {
	test(`${provider} HTTP 429 A to B success retains original row and observer accounting`, async () => {
		const capture = await captureLogs();
		const controller = new AbortController();
		// Keep Codex's bounded wire retries, but do not spend wall time on their backoff.
		const wait =
			provider === "openai-codex"
				? spyOn(scheduler, "wait").mockImplementation(async (_delay, options) => {
						options?.signal?.throwIfAborted();
					})
				: undefined;
		let restoredWait = false;
		const restoreWait = () => {
			if (restoredWait) return;
			restoredWait = true;
			wait?.mockRestore();
		};
		onTestFinished(() => {
			controller.abort();
			restoreWait();
		});
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		const limits = spyOn(storage.usage, "observeLimits");
		const outcomes = spyOn(storage.usage, "observeOutcome");
		const usage = spyOn(storage.usage, "observe");
		const billed: GatewayUsageEvent[] = [];
		let storageClosed = false;
		const closeStorage = () => {
			if (storageClosed) return;
			storageClosed = true;
			storage.close();
		};
		onTestFinished(closeStorage);
		const first = provider === "anthropic" ? secret.access : codexToken("synthetic-A");
		const second = provider === "anthropic" ? secret.apiB : codexToken("synthetic-B");
		if (provider === "anthropic")
			await storage.credentials.set(provider, [
				{
					type: "oauth",
					access: first,
					refresh: secret.refresh,
					expires: Date.now() + 3600000,
					accountId: "synthetic-A",
				},
				{ type: "api_key", key: second },
			]);
		else
			await storage.credentials.set(provider, [
				{ type: "api_key", key: first },
				{ type: "api_key", key: second },
			]);
		const rows = storage.credentials.list(provider);
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
		const bearers: Array<string | null> = [];
		let failedBearer: string | undefined;
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => model,
			apiKeyLimitModelClasses: { [model.id]: "sonnet-4.5" },
			onUsage: event => {
				billed.push(event);
			},
			fetch: async (_input, init) => {
				const headers = new Headers(init?.headers);
				const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? headers.get("x-api-key");
				if (bearer !== first && bearer !== second) throw new Error("expected a fixture bearer");
				// A is the first selected attempt, which session hashing need not map to the first stored row.
				failedBearer ??= bearer;
				bearers.push(bearer);
				if (bearer === failedBearer)
					return Response.json(
						{
							error: {
								type: "rate_limit_error",
								code: "usage_limit_reached",
								message: `usage limit reached ${secret.error}`,
							},
						},
						{
							status: 429,
							headers: {
								"x-should-retry": "false",
								"x-private": secret.header,
								"anthropic-ratelimit-unified-5h-utilization": "1",
								"anthropic-ratelimit-unified-5h-reset": "1900000000",
								"x-codex-primary-used-percent": "100",
								"x-codex-primary-window-minutes": "300",
								"x-codex-primary-reset-at": "1900000000",
							},
						},
					);
				return success(provider);
			},
		});
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			controller.abort();
			router.close();
			closeStorage();
		};
		onTestFinished(close);
		try {
			const response = await router.route(
				new Request("http://gateway/v1/pi/stream", {
					method: "POST",
					signal: controller.signal,
					headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
					body: JSON.stringify({
						modelId: model.id,
						context: { messages: [{ role: "user", content: secret.request, timestamp: 0 }] },
						stream: false,
						options: {
							preferWebsockets: false,
							maxRetryDelayMs: 1,
							headers: { "x-private": secret.header },
							metadata: { private: secret.metadata },
						},
					}),
				}),
				"peer",
				{ kind: "agent", agentAccountId: "agent", ownerUserId: "pool" },
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(secret.response);
			expect(new Set(bearers)).toEqual(new Set([first, second]));
			const succeededBearer = bearers.at(-1);
			expect(succeededBearer).not.toBe(failedBearer);
			if (provider === "anthropic") {
				expect(failedBearer).toBe(first);
				expect(succeededBearer).toBe(second);
			}
			const rowA = rows.find(row =>
				row.credential.type === "oauth"
					? row.credential.access === failedBearer
					: row.credential.type === "api_key" && row.credential.key === failedBearer,
			)?.id;
			const rowB = rows.find(row => row.credential.type === "api_key" && row.credential.key === succeededBearer)?.id;
			expect(rowA).toBeNumber();
			expect(rowB).toBeNumber();
			if (rowA === undefined || rowB === undefined) throw new Error("expected both sent credential rows");
			const observations = capture.matching("auth-gateway provider response");
			expect(observations.map(event => [event.context?.credentialId, event.context?.status])).toEqual([
				...Array.from({ length: provider === "openai-codex" ? 6 : 1 }, () => [rowA, 429]),
				[rowB, 200],
			]);
			expect(observations.at(-1)?.context?.pool).toBe("pool");
			expect(capture.matching("auth-gateway quota observation")[0]?.context).toMatchObject({
				credentialId: rowA,
				resetAtMs: 1900000000000,
			});
			expect(billed.map(event => [event.credentialId, event.outcome])).toEqual([[rowB, "ok"]]);
			expect(usage.mock.calls.map(call => [call[0].credentialId, call[0].outcome])).toEqual([[rowB, "ok"]]);
			expect(outcomes.mock.calls.map(call => [call[0].credentialId, call[0].outcome])).toEqual([[rowA, "error"]]);
			const mapped = limits.mock.calls
				.flatMap(call => call[0])
				.filter(observation => observation.modelClass !== undefined);
			expect(
				mapped.map(observation => [
					observation.credentialId,
					observation.modelClass,
					observation.limits.map(limit => [limit.window?.id, limit.amount.remaining]),
				]),
			).toEqual(provider === "anthropic" ? [[rowB, "sonnet-4.5", [["requests", 49]]]] : []);
			if (provider === "openai-codex") expect(wait?.mock.calls.length).toBeGreaterThan(0);
			await capture.assertSafe([first, second]);
		} finally {
			close();
			restoreWait();
			limits.mockRestore();
			outcomes.mockRestore();
			usage.mockRestore();
			await capture.close();
		}
	});
}
