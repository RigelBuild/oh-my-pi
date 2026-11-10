import { expect, spyOn, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel, withOfficialAnthropicEndpoint } from "../helpers";

withOfficialAnthropicEndpoint();
const context = { messages: [{ role: "user" as const, content: "synthetic", timestamp: 0 }] };
const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.bbb`;
function codexSuccess() {
	return new Response(
		'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
		{ headers: { "content-type": "text/event-stream" } },
	);
}
function anthropicSuccess() {
	return new Response(
		'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
		{ headers: { "content-type": "text/event-stream" } },
	);
}

test("Codex observer rejection cannot retransmit an accepted generation", async () => {
	const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	let observations = 0;
	try {
		const result = await streamOpenAICodexResponses(createCodexModel("gpt-5.5"), context, {
			apiKey: token,
			preferWebsockets: false,
			fetch: async () => {
				requests++;
				return codexSuccess();
			},
			onResponse: async () => {
				observations++;
				throw new Error("synthetic observer failure");
			},
		}).result();
		expect(requests).toBe(1);
		expect(observations).toBe(1);
		expect(result.stopReason).toBe("stop");
	} finally {
		wait.mockRestore();
	}
});

test("Codex disarms the successful-header deadline before a slow observer", async () => {
	vi.useFakeTimers();
	let fetchSignal: AbortSignal | null | undefined;
	let abortedDuringObservation: boolean | undefined;
	try {
		const result = await streamOpenAICodexResponses(createCodexModel("gpt-5.5"), context, {
			apiKey: token,
			preferWebsockets: false,
			streamFirstEventTimeoutMs: 5,
			fetch: async (_input, init) => {
				fetchSignal = init?.signal;
				return codexSuccess();
			},
			onResponse: async () => {
				vi.advanceTimersByTime(20);
				abortedDuringObservation = fetchSignal?.aborted;
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(abortedDuringObservation).toBe(false);
	} finally {
		vi.useRealTimers();
	}
});

for (const status of [429, 400])
	test(`Anthropic rejecting failure observer preserves ${status} recovery`, async () => {
		const model = buildModel({
			id: "claude-sonnet-4-5",
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
		const results = [];
		vi.useFakeTimers();
		try {
			for (const mode of ["control", "slow", "slow-reject"] as const) {
				let requests = 0;
				const statuses: number[] = [];
				const strictRequests: boolean[] = [];
				const observerAborts: boolean[] = [];
				let activeSignal: AbortSignal | null | undefined;
				const result = await streamAnthropic(
					model,
					{
						...context,
						tools: [{ name: "find", description: "lookup", parameters: { type: "object", properties: {} } }],
					},
					{
						apiKey: "synthetic-api-key",
						providerRetryWait: async () => {},
						streamFirstEventTimeoutMs: 5,
						fetch: async (_input, init) => {
							activeSignal = init?.signal;
							strictRequests.push(String(init?.body).includes('"strict":true'));
							requests++;
							if (status === 400 && requests > 1) return anthropicSuccess();
							return Response.json(
								{
									error: {
										type: status === 429 ? "rate_limit_error" : "invalid_request_error",
										message: status === 429 ? "usage limit reached" : "compiled grammar is too large",
									},
								},
								{ status, headers: { "x-should-retry": "false" } },
							);
						},
						onResponse: async response => {
							statuses.push(response.status);
							if (mode !== "control" && response.status !== 200) vi.advanceTimersByTime(20);
							if (response.status !== 200) observerAborts.push(activeSignal?.aborted ?? true);
							if (mode === "slow-reject" && response.status !== 200)
								throw new Error("synthetic observer failure");
						},
					},
				).result();
				results.push({
					requests,
					statuses,
					strictRequests,
					observerAborts,
					stopReason: result.stopReason,
					errorStatus: result.errorStatus,
				});
			}
			expect(results[1]).toEqual(results[0]);
			expect(results[2]).toEqual(results[0]);
			expect(results[0]?.statuses[0]).toBe(status);
			if (status === 400) {
				expect(results[0]?.requests).toBe(2);
				expect(results[0]?.strictRequests).toEqual([true, false]);
				expect(results[0]?.stopReason).toBe("stop");
			} else expect(results[0]?.errorStatus).toBe(429);
		} finally {
			vi.useRealTimers();
		}
	});

for (const status of [400, 429]) {
	test(`Codex ${status} error bodies exclude observer latency from their deadline`, async () => {
		const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.useFakeTimers();
		const results = [];
		try {
			for (const mode of ["control", "slow", "slow-reject"] as const) {
				let requests = 0;
				const result = await streamOpenAICodexResponses(createCodexModel("gpt-5.5"), context, {
					apiKey: token,
					preferWebsockets: false,
					streamFirstEventTimeoutMs: 5,
					codexSseMaxAttempts: 1,
					fetch: async (_input, init) => {
						requests++;
						const body = new ReadableStream<Uint8Array>(
							{
								start(controller) {
									init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
										once: true,
									});
								},
								pull(controller) {
									controller.enqueue(
										new TextEncoder().encode(
											JSON.stringify({
												error: { message: "synthetic rejection", code: "invalid_request_error" },
											}),
										),
									);
									controller.close();
								},
							},
							{ highWaterMark: 0 },
						);
						return new Response(body, { status });
					},
					onResponse: async () => {
						if (mode !== "control") vi.advanceTimersByTime(20);
						if (mode === "slow-reject") throw new Error("synthetic observer failure");
					},
				}).result();
				results.push({
					requests,
					status: result.errorStatus,
					reason: result.stopReason,
					message: result.errorMessage,
				});
			}
			expect(results[1]).toEqual(results[0]);
			expect(results[2]).toEqual(results[0]);
			expect(results[0]?.status).toBe(status);
		} finally {
			vi.useRealTimers();
			wait.mockRestore();
		}
	});
}

test("Codex stalled rejected body still aborts after observation", async () => {
	const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
	vi.useFakeTimers();
	let aborted = false;
	try {
		const result = await streamOpenAICodexResponses(createCodexModel("gpt-5.5"), context, {
			apiKey: token,
			preferWebsockets: false,
			streamFirstEventTimeoutMs: 5,
			codexSseMaxAttempts: 1,
			fetch: async (_input, init) =>
				new Response(
					new ReadableStream(
						{
							start(controller) {
								init?.signal?.addEventListener(
									"abort",
									() => {
										aborted = true;
										controller.error(init.signal?.reason);
									},
									{ once: true },
								);
							},
							pull() {
								vi.advanceTimersByTime(20);
							},
						},
						{ highWaterMark: 0 },
					),
					{ status: 400 },
				),
			onResponse: async () => {
				vi.advanceTimersByTime(20);
			},
		}).result();
		expect(aborted).toBe(true);
		expect(result.stopReason).toBe("error");
	} finally {
		vi.useRealTimers();
		wait.mockRestore();
	}
});
