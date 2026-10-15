/**
 * Pre-first-byte candidate failover in the auth-gateway chat routes.
 *
 * With `candidateFailover` set, a candidate whose failure before its first
 * meaningful event is eligible for failover hands the request to the next
 * candidate, if one exists. A terminal failure such as a 400, or an eligible
 * failure with no follower, still answers the client with that error.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	AUTH_GATEWAY_MAX_SESSION_STATES,
	type AuthGatewayRouteOptions,
	bearerTokenAuthorizer,
	type CandidateFailoverOptions,
	createAuthGatewayRouter,
	type FailoverContext,
	type GatewayUsageEvent,
	SHARED_TOKEN_CALLER,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { candidateKey } from "@oh-my-pi/pi-ai/auth-gateway/failover";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import {
	create as createErrorId,
	Flag,
	ProviderHttpError,
	type UpstreamFailure,
	type UpstreamFailureKind,
} from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as piStream from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";
import { withOfficialAnthropicEndpoint } from "./helpers";
import { responsesChunks } from "./helpers/factory-droid";

const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

interface ChatRoute {
	readonly path: string;
	body(model: string, stream: boolean): Record<string, unknown>;
}

const ROUTES: readonly ChatRoute[] = [
	{
		path: "/v1/chat/completions",
		body: (model, stream) => ({ model, messages: [{ role: "user", content: "hello" }], stream }),
	},
	{
		path: "/v1/messages",
		body: (model, stream) => ({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 64, stream }),
	},
	{ path: "/v1/responses", body: (model, stream) => ({ model, input: "hello", stream }) },
	{ path: "/v1/pi/stream", body: (model, stream) => ({ modelId: model, context: CONTEXT, stream }) },
];

const CHAT = ROUTES[0] as ChatRoute;
const PI = ROUTES[3] as ChatRoute;
const ROUTE_MODES = ROUTES.flatMap(route => [true, false].map(stream => [route.path, stream] as const));

function routeByPath(pathname: string): ChatRoute {
	const route = ROUTES.find(candidate => candidate.path === pathname);
	if (!route) throw new Error(`unknown route ${pathname}`);
	return route;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function googleModel(id: string, host: string, extra?: Partial<ModelSpec<"google-generative-ai">>): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: `https://${host}/v1beta`,
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 8_192,
		...extra,
	} satisfies ModelSpec<"google-generative-ai">);
}

function anthropicModel(id: string, host: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: `https://${host}`,
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"anthropic-messages">);
}

function responsesModel(id: string, host: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: `https://${host}/v1`,
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"openai-responses">);
}

const A_HOST = "candidate-a.invalid";
const B_HOST = "candidate-b.invalid";
const C_HOST = "candidate-c.invalid";

function geminiText(text: string): string {
	return JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] });
}

function geminiFinish(): string {
	return JSON.stringify({
		candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 3 },
	});
}

function geminiError(code: number, message: string, status: string): string {
	return JSON.stringify({ error: { code, message, status } });
}

function sse(chunks: readonly string[]): Response {
	return new Response(chunks.map(chunk => `data: ${chunk}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function googleAnswer(text: string): Response {
	return sse([geminiText(text), geminiFinish()]);
}

function jsonError(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

const GOOGLE_503 = { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } };

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("aborted", "AbortError");
}

/** A response that never arrives; it rejects only when the attempt is aborted. */
function never(signal: AbortSignal | null | undefined): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	if (signal?.aborted) reject(abortError(signal));
	signal?.addEventListener("abort", () => reject(abortError(signal)), { once: true });
	return promise;
}

/**
 * An SSE body the test feeds by hand. `consumed` resolves when the reader asks
 * for more after taking every chunk sent so far, so the gateway has seen them.
 */
interface HeldBody {
	readonly response: Response;
	send(chunk: string): void;
	close(): void;
	readonly consumed: Promise<void>;
}

function heldBody(signal: AbortSignal | null | undefined, first: string): HeldBody {
	const encoder = new TextEncoder();
	const consumed = Promise.withResolvers<void>();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			start(c) {
				controller = c;
			},
			pull(c) {
				pulls++;
				if (pulls === 1) c.enqueue(encoder.encode(`data: ${first}\n\n`));
				else if (pulls === 2) consumed.resolve();
			},
		},
		{ highWaterMark: 0 },
	);
	signal?.addEventListener("abort", () => controller?.error(abortError(signal)), { once: true });
	return {
		response: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
		send: chunk => controller?.enqueue(encoder.encode(`data: ${chunk}\n\n`)),
		close: () => controller?.close(),
		consumed: consumed.promise,
	};
}

type Handler = (init: RequestInit | undefined, call: number) => Response | Promise<Response>;

interface UpstreamCall {
	readonly host: string;
	readonly signal: AbortSignal | undefined;
	readonly abortedAtCall: boolean;
}

/** One injected `fetch` serving every candidate host; records each call. */
function upstream(handlers: Readonly<Record<string, Handler>>) {
	const calls: UpstreamCall[] = [];
	const counts = new Map<string, number>();
	const firstCall = new Map<string, PromiseWithResolvers<void>>();
	const called = (host: string): PromiseWithResolvers<void> => {
		let entry = firstCall.get(host);
		if (!entry) {
			entry = Promise.withResolvers<void>();
			firstCall.set(host, entry);
		}
		return entry;
	};
	const fetchImpl: FetchImpl = async (input, init) => {
		const host = new URL(input instanceof Request ? input.url : input.toString()).hostname;
		const signal = init?.signal ?? undefined;
		calls.push({ host, signal, abortedAtCall: signal?.aborted === true });
		const count = (counts.get(host) ?? 0) + 1;
		counts.set(host, count);
		called(host).resolve();
		const handler = handlers[host];
		if (!handler) throw new Error(`unexpected upstream ${host}`);
		return handler(init, count);
	};
	return {
		fetch: fetchImpl,
		calls,
		hosts: () => calls.map(call => call.host),
		count: (host: string) => counts.get(host) ?? 0,
		reached: (host: string) => called(host).promise,
	};
}

interface RecordedFailure {
	readonly model: Model<Api>;
	readonly failure: UpstreamFailure;
}

interface FailoverFixtureOptions {
	readonly candidates: readonly Model<Api>[];
	readonly fetch?: FetchImpl;
	readonly deadlineMs?: number;
	/** Requested ids answered by one candidate with no follower, like a direct selector. */
	readonly direct?: Readonly<Record<string, Model<Api>>>;
	/** Replaces the chain's `next`; the default walks `candidates` in order. */
	readonly next?: CandidateFailoverOptions["next"];
	readonly onUsage?: AuthGatewayRouteOptions["onUsage"];
}

interface FailoverFixture {
	readonly url: string;
	readonly storage: AuthStorage;
	readonly failures: RecordedFailure[];
	readonly routeOptions: AuthGatewayRouteOptions;
	cleanup(): Promise<void>;
}

/** Candidates in chain order: `next` returns the first one not yet tried. */
function chainFailover(
	candidates: readonly Model<Api>[],
	failures: RecordedFailure[],
	direct: Readonly<Record<string, Model<Api>>>,
	deadlineMs: number | undefined,
): CandidateFailoverOptions {
	return {
		next: async (modelId, ctx) => {
			if (modelId in direct) return undefined;
			return candidates.find(candidate => !ctx.tried.has(candidateKey(candidate)));
		},
		onFailure: (model, failure) => {
			failures.push({ model, failure });
		},
		...(deadlineMs !== undefined && { deadlineMs }),
	};
}

async function startFailoverGateway(options: FailoverFixtureOptions): Promise<FailoverFixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-failover-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const direct = options.direct ?? {};
	const models = [...options.candidates, ...Object.values(direct)];
	for (const provider of new Set(models.map(model => model.provider))) {
		storage.keys.setRuntime(provider, provider === "anthropic" ? "sk-ant-api-test" : "test-key");
	}
	const failures: RecordedFailure[] = [];
	const [primary] = options.candidates;
	if (!primary) throw new Error("need a primary candidate");
	const routeOptions: AuthGatewayRouteOptions = {
		storage,
		resolveModel: modelId => direct[modelId] ?? primary,
		candidateFailover: {
			...chainFailover(options.candidates, failures, direct, options.deadlineMs),
			...(options.next && { next: options.next }),
		},
		...(options.fetch && { fetch: options.fetch }),
		...(options.onUsage && { onUsage: options.onUsage }),
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer(["test-token"]),
		version: "test",
		...routeOptions,
	});
	return {
		url: handle.url,
		storage,
		failures,
		routeOptions,
		cleanup: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function send(url: string, route: ChatRoute, stream: boolean, model = "requested-model"): Promise<Response> {
	return fetch(`${url}${route.path}`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify(route.body(model, stream)),
	});
}

/** One real event-loop turn; fake timers do not hold it back. */
function macrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const channel = new MessageChannel();
	channel.port1.onmessage = () => {
		channel.port1.close();
		resolve();
	};
	channel.port2.postMessage(0);
	return promise;
}

async function settle(turns = 20): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await macrotask();
}

function failoverLogs(warn: {
	readonly mock: { readonly calls: readonly unknown[][] };
}): Array<Record<string, unknown>> {
	return warn.mock.calls
		.filter(call => call[0] === "auth-gateway candidate failover")
		.map(call => (call[1] ?? {}) as Record<string, unknown>);
}

function kinds(failures: readonly RecordedFailure[]): Array<[string, UpstreamFailureKind]> {
	return failures.map(entry => [entry.model.id, entry.failure.kind]);
}

function reply(model: Model<Api>, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...fields,
	};
}

/** Plays `events`; with `stall`, then waits and ends as aborted only when the attempt signal fires. */
function handStream(
	model: Model<Api>,
	signal: AbortSignal | undefined,
	events: readonly AssistantMessageEvent[],
	stall = false,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) stream.push(event);
	});
	if (stall) {
		const abort = (): void =>
			stream.push({
				type: "error",
				reason: "aborted",
				error: reply(model, { stopReason: "aborted", errorMessage: "Request was aborted" }),
			});
		if (signal?.aborted) queueMicrotask(abort);
		else signal?.addEventListener("abort", abort, { once: true });
	}
	return stream;
}

type Script = (options: SimpleStreamOptions | undefined, call: number) => AssistantMessageEventStream;

/** Spies `streamSimple`: scripted model ids get `script`, others the real dispatch; every call's options are kept. */
function scriptStreams(scripts: Readonly<Record<string, Script>>) {
	const real = piStream.streamSimple;
	const calls = new Map<string, Array<SimpleStreamOptions | undefined>>();
	const spy = spyOn(piStream, "streamSimple").mockImplementation((model, context, options) => {
		const seen = calls.get(model.id) ?? [];
		calls.set(model.id, seen);
		seen.push(options);
		const script = scripts[model.id];
		return script ? script(options, seen.length) : real(model, context, options);
	});
	return {
		options: (modelId: string): ReadonlyArray<SimpleStreamOptions | undefined> => calls.get(modelId) ?? [],
		[Symbol.dispose]: () => spy.mockRestore(),
	};
}

withOfficialAnthropicEndpoint();

afterEach(() => {
	vi.useRealTimers();
	clearCustomApis();
});

describe("auth-gateway candidate failover", () => {
	const a = googleModel("candidate-a", A_HOST);
	const b = googleModel("candidate-b", B_HOST);

	describe.each([
		["fetch failed", "transport", () => Promise.reject(new TypeError("fetch failed"))],
		["503", "server_error", () => jsonError(503, GOOGLE_503)],
	] as const)("when A fails with %s", (_label, kind, failA) => {
		it.each(ROUTE_MODES)("answers %s (stream=%p) from B", async (routePath, stream) => {
			const up = upstream({ [A_HOST]: () => failA(), [B_HOST]: () => googleAnswer("answer from B") });
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			try {
				const response = await send(gateway.url, routeByPath(routePath), stream);
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("answer from B");
				expect(up.hosts()).toEqual([A_HOST, B_HOST]);
				expect(gateway.failures).toHaveLength(1);
				expect(gateway.failures[0]?.model).toBe(a);
				expect(gateway.failures[0]?.failure.kind).toBe(kind);
			} finally {
				await gateway.cleanup();
			}
		});
	});

	describe("A's attempt budget", () => {
		const anthropicA = anthropicModel("candidate-a-anthropic", A_HOST);
		const cases = [
			{
				name: "its fetch never resolves",
				primary: a,
				handler: ((init: RequestInit | undefined) => never(init?.signal)) satisfies Handler,
				retried: false,
			},
			{
				name: "Google answers 200 and then stalls",
				primary: a,
				handler: ((init: RequestInit | undefined) => heldBody(init?.signal, "").response) satisfies Handler,
				retried: false,
			},
			{
				name: "Anthropic is still retrying a 503",
				primary: anthropicA,
				handler: (() =>
					jsonError(503, {
						type: "error",
						error: { type: "overloaded_error", message: "Overloaded" },
					})) satisfies Handler,
				retried: true,
			},
		];

		describe.each(cases)("fires when $name", ({ primary, handler, retried }) => {
			it.each([true, false])("and B answers (stream=%p)", async stream => {
				const up = upstream({ [A_HOST]: handler, [B_HOST]: () => googleAnswer("answer from B") });
				const gateway = await startFailoverGateway({ candidates: [primary, b], fetch: up.fetch });
				try {
					vi.useFakeTimers();
					const pending = send(gateway.url, CHAT, stream);
					await up.reached(A_HOST);
					if (retried) {
						// Let the provider's own backoff run once, so the budget cuts a retry loop.
						while (up.count(A_HOST) < 2) {
							vi.advanceTimersByTime(1_000);
							await settle(1);
						}
					}
					expect(up.count(B_HOST)).toBe(0);
					vi.advanceTimersByTime(60_000);
					const response = await pending;
					const body = await response.text();

					expect(response.status).toBe(200);
					expect(body).toContain("answer from B");
					expect(kinds(gateway.failures)).toEqual([[primary.id, "server_error"]]);
					expect(gateway.failures[0]?.failure.message).toContain("Gateway attempt budget expired");
					// A retrying provider may be in backoff when the budget fires, with no call in flight.
					if (!retried) expect(up.calls.find(call => call.host === A_HOST)?.signal?.aborted).toBe(true);
					const bCall = up.calls.find(call => call.host === B_HOST);
					expect(bCall?.abortedAtCall).toBe(false);
					expect(bCall?.signal?.aborted).toBe(false);
				} finally {
					vi.useRealTimers();
					await gateway.cleanup();
				}
			});
		});
	});

	it.each(ROUTES.map(route => route.path))(
		"returns 499 and starts no follower when the client aborts while A is held on %s",
		async routePath => {
			const up = upstream({ [A_HOST]: init => never(init?.signal), [B_HOST]: () => googleAnswer("answer from B") });
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			const router = createAuthGatewayRouter(gateway.routeOptions);
			try {
				const client = new AbortController();
				const route = routeByPath(routePath);
				const pending = router.route(
					new Request(`http://gateway.local${route.path}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(route.body("requested-model", false)),
						signal: client.signal,
					}),
					"test-peer",
					SHARED_TOKEN_CALLER,
				);
				await up.reached(A_HOST);
				client.abort(new Error("client went away"));
				const response = await pending;

				expect(response.status).toBe(499);
				expect(up.hosts()).toEqual([A_HOST]);
				expect(gateway.failures).toEqual([]);
			} finally {
				router.close();
				await gateway.cleanup();
			}
		},
	);

	it("keeps a non-streaming A that sends its first delta before the budget and finishes after it", async () => {
		let held: HeldBody | undefined;
		const up = upstream({
			[A_HOST]: init => {
				held = heldBody(init?.signal, geminiText("answer from A"));
				return held.response;
			},
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		try {
			vi.useFakeTimers();
			const pending = send(gateway.url, CHAT, false);
			await up.reached(A_HOST);
			await held?.consumed;
			await settle();
			vi.advanceTimersByTime(61_000);
			held?.send(geminiFinish());
			held?.close();
			const response = await pending;
			const body = await response.text();

			expect(response.status).toBe(200);
			expect(body).toContain("answer from A");
			expect(up.hosts()).toEqual([A_HOST]);
			expect(gateway.failures).toEqual([]);
		} finally {
			vi.useRealTimers();
			await gateway.cleanup();
		}
	});

	it.each(ROUTES.map(route => route.path))(
		"relays A's text and A's error when A fails after a text_delta on streaming %s",
		async routePath => {
			const up = upstream({
				[A_HOST]: () =>
					sse([geminiText("partial from A"), geminiError(503, "Upstream connection reset", "UNAVAILABLE")]),
				[B_HOST]: () => googleAnswer("answer from B"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			try {
				const response = await send(gateway.url, routeByPath(routePath), true);
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("partial from A");
				expect(body).toContain("Upstream connection reset");
				expect(body).not.toContain("answer from B");
				expect(up.hosts()).toEqual([A_HOST]);
				expect(gateway.failures).toEqual([]);
			} finally {
				await gateway.cleanup();
			}
		},
	);

	it.each([true, false])(
		"fails over a usage limit on A's only credential as credential_exhausted (stream=%p)",
		async stream => {
			const billingCap = {
				error: {
					code: 429,
					message: "Your project has exceeded its monthly spending cap.",
					status: "RESOURCE_EXHAUSTED",
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
				},
			};
			const bOther = googleModel("candidate-b", B_HOST, { provider: "google-b" });
			const up = upstream({
				[A_HOST]: () => jsonError(429, billingCap),
				[B_HOST]: () => googleAnswer("answer from B"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, bOther], fetch: up.fetch });
			try {
				const response = await send(gateway.url, CHAT, stream);
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("answer from B");
				expect(kinds(gateway.failures)).toEqual([[a.id, "credential_exhausted"]]);
			} finally {
				await gateway.cleanup();
			}
		},
	);

	describe("setup failures", () => {
		it.each([true, false])("fails over when A's credential store throws (stream=%p)", async stream => {
			const up = upstream({
				[A_HOST]: () => googleAnswer("answer from A"),
				[B_HOST]: () => googleAnswer("answer from B"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			const keys = gateway.storage.keys;
			const real = keys.getWithCredential.bind(keys);
			const lookup = spyOn(keys, "getWithCredential").mockImplementation((provider, sessionId, options) => {
				if (options?.modelId === a.id) return Promise.reject(new Error("credential store offline"));
				return real(provider, sessionId, options);
			});
			try {
				const response = await send(gateway.url, CHAT, stream);
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("answer from B");
				expect(up.hosts()).toEqual([B_HOST]);
				expect(kinds(gateway.failures)).toEqual([[a.id, "setup_error"]]);
			} finally {
				lookup.mockRestore();
				await gateway.cleanup();
			}
		});

		it.each([true, false])("fails over when streamSimple throws synchronously for A (stream=%p)", async stream => {
			const up = upstream({
				[A_HOST]: () => googleAnswer("answer from A"),
				[B_HOST]: () => googleAnswer("answer from B"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			const real = piStream.streamSimple;
			const dispatch = spyOn(piStream, "streamSimple").mockImplementation((model, context, options) => {
				if (model.id === a.id) throw new Error("provider setup exploded");
				return real(model, context, options);
			});
			try {
				const response = await send(gateway.url, CHAT, stream);
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("answer from B");
				expect(up.hosts()).toEqual([B_HOST]);
				expect(kinds(gateway.failures)).toEqual([[a.id, "setup_error"]]);
			} finally {
				dispatch.mockRestore();
				await gateway.cleanup();
			}
		});

		it("does not cut A's credential lookup at the budget A would get", async () => {
			const up = upstream({
				[A_HOST]: () => googleAnswer("answer from A"),
				[B_HOST]: () => googleAnswer("answer from B"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			const keys = gateway.storage.keys;
			const real = keys.getWithCredential.bind(keys);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const lookup = spyOn(keys, "getWithCredential").mockImplementation(async (provider, sessionId, options) => {
				if (options?.modelId === a.id) {
					started.resolve();
					await release.promise;
				}
				return real(provider, sessionId, options);
			});
			try {
				vi.useFakeTimers();
				const pending = send(gateway.url, CHAT, false);
				await started.promise;
				vi.advanceTimersByTime(70_000);
				await settle();
				release.resolve();
				const response = await pending;
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("answer from A");
				expect(up.hosts()).toEqual([A_HOST]);
				expect(gateway.failures).toEqual([]);
			} finally {
				vi.useRealTimers();
				lookup.mockRestore();
				await gateway.cleanup();
			}
		});

		it.each([true, false])(
			"aborts a credential lookup still running at deadlineMs with a 502 (stream=%p)",
			async stream => {
				const up = upstream({
					[A_HOST]: () => googleAnswer("answer from A"),
					[B_HOST]: () => googleAnswer("answer from B"),
				});
				const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
				const keys = gateway.storage.keys;
				const real = keys.getWithCredential.bind(keys);
				const started = Promise.withResolvers<void>();
				let lookupSignal: AbortSignal | undefined;
				const lookup = spyOn(keys, "getWithCredential").mockImplementation((provider, sessionId, options) => {
					if (options?.modelId !== a.id) return real(provider, sessionId, options);
					lookupSignal = options.signal;
					started.resolve();
					return new Promise(() => {});
				});
				const warn = spyOn(logger, "warn");
				try {
					vi.useFakeTimers();
					const pending = send(gateway.url, CHAT, stream);
					await started.promise;
					vi.advanceTimersByTime(120_000);
					const response = await pending;
					const body = await response.text();

					expect(response.status).toBe(502);
					expect(body).toContain("Gateway request deadline expired");
					expect(lookupSignal?.aborted).toBe(true);
					expect(up.hosts()).toEqual([]);
					expect(kinds(gateway.failures)).toEqual([[a.id, "setup_error"]]);
					expect(failoverLogs(warn)).toEqual([
						expect.objectContaining({ resolvedModel: a.id, outcome: "deadline" }),
					]);
				} finally {
					vi.useRealTimers();
					warn.mockRestore();
					lookup.mockRestore();
					await gateway.cleanup();
				}
			},
		);
	});

	it("answers with A's error when a non-streaming A fails after deadlineMs", async () => {
		let held: HeldBody | undefined;
		const up = upstream({
			[A_HOST]: init => {
				held = heldBody(init?.signal, geminiText("partial from A"));
				return held.response;
			},
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		const warn = spyOn(logger, "warn");
		try {
			vi.useFakeTimers();
			const pending = send(gateway.url, CHAT, false);
			await up.reached(A_HOST);
			await held?.consumed;
			await settle();
			vi.advanceTimersByTime(121_000);
			held?.send(geminiError(503, "The model is overloaded.", "UNAVAILABLE"));
			held?.close();
			const response = await pending;
			const body = await response.text();

			expect(response.status).not.toBe(200);
			expect(body).toContain("The model is overloaded.");
			expect(up.hosts()).toEqual([A_HOST]);
			expect(kinds(gateway.failures)).toEqual([[a.id, "server_error"]]);
			expect(failoverLogs(warn)).toEqual([expect.objectContaining({ resolvedModel: a.id, outcome: "deadline" })]);
		} finally {
			vi.useRealTimers();
			warn.mockRestore();
			await gateway.cleanup();
		}
	});

	it("writes an SSE error into the open 200 body when B has no credential", async () => {
		const up = upstream({
			[A_HOST]: () => jsonError(503, GOOGLE_503),
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		const keys = gateway.storage.keys;
		const real = keys.getWithCredential.bind(keys);
		const lookup = spyOn(keys, "getWithCredential").mockImplementation((provider, sessionId, options) =>
			options?.modelId === b.id ? Promise.resolve(undefined) : real(provider, sessionId, options),
		);
		try {
			const response = await send(gateway.url, PI, true);
			const body = await response.text();

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			expect(body).toContain('"type":"error"');
			expect(body).toContain("No credential available for provider google");
			expect(up.hosts()).toEqual([A_HOST]);
			expect(kinds(gateway.failures)).toEqual([
				[a.id, "server_error"],
				[b.id, "credential_exhausted"],
			]);
		} finally {
			lookup.mockRestore();
			await gateway.cleanup();
		}
	});

	describe("skips a follower that fails a route precheck", () => {
		it.each([true, false])("passes over an embedding model to a third chat candidate (stream=%p)", async stream => {
			const embedding = googleModel("candidate-b-embedding", B_HOST, { kind: "embedding" });
			const c = googleModel("candidate-c", C_HOST);
			const up = upstream({
				[A_HOST]: () => jsonError(503, GOOGLE_503),
				[B_HOST]: () => googleAnswer("answer from B"),
				[C_HOST]: () => googleAnswer("answer from C"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, embedding, c], fetch: up.fetch });
			const warn = spyOn(logger, "warn");
			try {
				const response = await send(gateway.url, CHAT, stream);
				const body = await response.text();

				expect(response.status).toBe(200);
				expect(body).toContain("answer from C");
				expect(up.hosts()).toEqual([A_HOST, C_HOST]);
				expect(kinds(gateway.failures)).toEqual([[a.id, "server_error"]]);
				expect(failoverLogs(warn).map(log => [log.resolvedModel, log.outcome])).toEqual([
					[a.id, "retrying"],
					[embedding.id, "skipped"],
				]);
			} finally {
				warn.mockRestore();
				await gateway.cleanup();
			}
		});

		it.each([true, false])(
			"passes over a non-Responses model for an OpenAI file id on /v1/responses (stream=%p)",
			async stream => {
				const responsesA = responsesModel("candidate-a-responses", A_HOST);
				const responsesC = responsesModel("candidate-c-responses", C_HOST);
				const up = upstream({
					// A long retry hint makes the transport return the 503 instead of sleeping on it.
					[A_HOST]: () =>
						jsonError(
							503,
							{ error: { message: "upstream unavailable", type: "server_error" } },
							{ "retry-after": "999" },
						),
					[B_HOST]: () => googleAnswer("answer from B"),
					[C_HOST]: () =>
						sse([
							JSON.stringify({
								type: "response.output_item.added",
								item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
							}),
							JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
							...responsesChunks("answer from C"),
						]),
				});
				const gateway = await startFailoverGateway({ candidates: [responsesA, b, responsesC], fetch: up.fetch });
				try {
					const response = await fetch(`${gateway.url}/v1/responses`, {
						method: "POST",
						headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
						body: JSON.stringify({
							model: "requested-model",
							stream,
							input: [
								{ type: "function_call", call_id: "call_read", name: "read", arguments: "{}" },
								{
									type: "function_call_output",
									call_id: "call_read",
									output: [{ type: "input_image", file_id: "file_image_123" }],
								},
							],
						}),
					});
					const body = await response.text();

					expect(response.status).toBe(200);
					expect(body).toContain("answer from C");
					expect(up.hosts()).toEqual([A_HOST, C_HOST]);
					expect(kinds(gateway.failures)).toEqual([[responsesA.id, "server_error"]]);
				} finally {
					await gateway.cleanup();
				}
			},
		);
	});

	it.each([true, false])("does not fail over a 400 from A (stream=%p)", async stream => {
		const badRequest = {
			error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" },
		};
		const up = upstream({
			[A_HOST]: () => jsonError(400, badRequest),
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		const warn = spyOn(logger, "warn");
		try {
			const response = await send(gateway.url, CHAT, stream);
			const body = await response.text();

			expect(body).toContain("Request contains an invalid argument.");
			expect(body).not.toContain("answer from B");
			if (!stream) expect(response.status).toBe(400);
			expect(up.hosts()).toEqual([A_HOST]);
			expect(gateway.failures).toEqual([]);
			// A terminal stop is still logged, without `onFailure`.
			expect(failoverLogs(warn)).toEqual([
				expect.objectContaining({ resolvedModel: a.id, outcome: "exhausted", status: 400 }),
			]);
		} finally {
			warn.mockRestore();
			await gateway.cleanup();
		}
	});

	it.each([true, false])("makes one attempt for a direct selector (stream=%p)", async stream => {
		const up = upstream({
			[A_HOST]: () => jsonError(503, GOOGLE_503),
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({
			candidates: [b],
			direct: { "google/candidate-a": a },
			fetch: up.fetch,
		});
		try {
			const response = await send(gateway.url, CHAT, stream, "google/candidate-a");
			const body = await response.text();

			expect(body).toContain("The model is overloaded.");
			expect(body).not.toContain("answer from B");
			if (!stream) expect(response.status).toBe(503);
			expect(up.hosts()).toEqual([A_HOST]);
			expect(kinds(gateway.failures)).toEqual([[a.id, "server_error"]]);
		} finally {
			await gateway.cleanup();
		}
	});

	it.each([true, false])(
		"releases every attempt's session-state lease across setup-throw, 503, and budget exits (stream=%p)",
		async stream => {
			registerMockApi();
			const mockA = createMockModel({ provider: "mock-a", id: "candidate-a-mock", handler: () => ({}) });
			const mockB = createMockModel({
				provider: "mock-b",
				id: "candidate-b-mock",
				handler: () => {
					throw new ProviderHttpError("upstream unavailable", 503);
				},
			});
			const mockC = createMockModel({
				provider: "mock-c",
				id: "candidate-c-mock",
				handler: () => ({ delayMs: 1_000_000, content: ["too late"] }),
			});
			const mockD = createMockModel({
				provider: "mock-d",
				id: "candidate-d-mock",
				handler: () => ({ content: ["answer from D"] }),
			});
			const gateway = await startFailoverGateway({
				candidates: [mockA, mockB, mockC, mockD],
				direct: { filler: mockD },
			});
			using streams = scriptStreams({
				[mockA.id]: () => {
					throw new Error("provider setup exploded");
				},
			});
			try {
				vi.useFakeTimers();
				const pending = send(gateway.url, PI, stream);
				while (mockC.calls.length === 0) await settle(1);
				vi.advanceTimersByTime(61_000);
				const response = await pending;
				expect(await response.text()).toContain("answer from D");
				vi.useRealTimers();
				expect(kinds(gateway.failures)).toEqual([
					[mockA.id, "setup_error"],
					[mockB.id, "server_error"],
					[mockC.id, "server_error"],
				]);

				const closed: string[] = [];
				const probes = [
					["a", streams.options(mockA.id)[0]?.providerSessionState],
					["b", mockB.calls[0]?.options?.providerSessionState],
					["c", mockC.calls[0]?.options?.providerSessionState],
					["d", mockD.calls[0]?.options?.providerSessionState],
				] as const;
				for (const [label, states] of probes) {
					expect(states).toBeDefined();
					states?.set("probe", { close: () => closed.push(label) });
				}

				// A leaked lease pins its entry, so filling the store never evicts it.
				for (let index = 0; index < AUTH_GATEWAY_MAX_SESSION_STATES; index++) {
					const filler = await fetch(`${gateway.url}/v1/pi/stream`, {
						method: "POST",
						headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
						body: JSON.stringify({
							modelId: "filler",
							context: CONTEXT,
							options: { sessionId: `filler-${index}` },
							stream: false,
						}),
					});
					if (!filler.ok) throw new Error(`filler ${index} failed with ${filler.status}`);
					await filler.json();
				}

				expect(closed.sort()).toEqual(["a", "b", "c", "d"]);
			} finally {
				vi.useRealTimers();
				await gateway.cleanup();
			}
		},
	);

	it.each([
		["an already-tried candidate", () => a],
		["the same incompatible follower", () => googleModel("candidate-b-embedding", B_HOST, { kind: "embedding" })],
	])("does not loop when next keeps returning %s", async (_label, repeat) => {
		const repeated = repeat();
		const up = upstream({
			[A_HOST]: () => jsonError(503, GOOGLE_503),
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch, next: async () => repeated });
		try {
			const response = await send(gateway.url, CHAT, false);
			const body = await response.text();

			expect(response.status).toBe(503);
			expect(body).toContain("The model is overloaded.");
			expect(up.hosts()).toEqual([A_HOST]);
		} finally {
			await gateway.cleanup();
		}
	});

	it("aborts an attempt that hits the pre-commit event cap before starting B", async () => {
		const up = upstream({ [B_HOST]: () => googleAnswer("answer from B") });
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		const partial = reply(a, {});
		using streams = scriptStreams({
			[a.id]: options =>
				handStream(
					a,
					options?.signal,
					[
						{ type: "start", partial },
						...Array.from({ length: 300 }, () => ({ type: "text_start" as const, contentIndex: 0, partial })),
					],
					true,
				),
		});
		try {
			const response = await send(gateway.url, CHAT, true);
			const body = await response.text();

			expect(body).toContain("answer from B");
			expect(streams.options(a.id)[0]?.signal?.aborted).toBe(true);
			expect(kinds(gateway.failures)).toEqual([[a.id, "server_error"]]);
		} finally {
			await gateway.cleanup();
		}
	});

	it.each([true, false])(
		"reports each nonzero attempt's usage once under its own request id (stream=%p)",
		async stream => {
			const up = upstream({ [B_HOST]: () => googleAnswer("answer from B") });
			const events: GatewayUsageEvent[] = [];
			const gateway = await startFailoverGateway({
				candidates: [a, b],
				fetch: up.fetch,
				onUsage: event => {
					events.push(event);
				},
			});
			const spent = reply(a, {
				stopReason: "error",
				errorMessage: "The model is overloaded.",
				usage: {
					input: 5,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			using _streams = scriptStreams({
				[a.id]: options => handStream(a, options?.signal, [{ type: "error", reason: "error", error: spent }]),
			});
			try {
				const response = await send(gateway.url, CHAT, stream);
				expect(await response.text()).toContain("answer from B");
				await settle();

				const requestId = response.headers.get("x-request-id") ?? "";
				expect(requestId).not.toBe("");
				expect(events.map(event => [event.model, event.outcome, event.requestId])).toEqual([
					[a.id, "error", `${requestId}:a1`],
					[b.id, "ok", requestId],
				]);
			} finally {
				await gateway.cleanup();
			}
		},
	);

	describe("maxRetryDelayMs", () => {
		it.each([
			["keeps a client's 30 s on a direct selector", "google/candidate-a", 30_000, 30_000],
			["leaves it unset on a direct selector", "google/candidate-a", undefined, undefined],
			["caps it at 10 s with a follower", "requested-model", 30_000, 10_000],
			["keeps a client's lower cap with a follower", "requested-model", 5_000, 5_000],
			["keeps a client's disabled cap on a direct selector", "google/candidate-a", 0, 0],
			["caps a client's disabled cap at 10 s with a follower", "requested-model", 0, 10_000],
			["caps a negative client value at 10 s with a follower", "requested-model", -1, 10_000],
		] as const)("%s", async (_label, modelId, requested, expected) => {
			const up = upstream({ [A_HOST]: () => googleAnswer("answer from A") });
			const gateway = await startFailoverGateway({
				candidates: [a, b],
				direct: { "google/candidate-a": a },
				fetch: up.fetch,
			});
			using streams = scriptStreams({});
			try {
				const response = await fetch(`${gateway.url}/v1/pi/stream`, {
					method: "POST",
					headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
					body: JSON.stringify({
						modelId,
						context: CONTEXT,
						stream: false,
						...(requested !== undefined && { options: { maxRetryDelayMs: requested } }),
					}),
				});
				expect(await response.text()).toContain("answer from A");
				expect(streams.options(a.id)[0]?.maxRetryDelayMs).toBe(expected);
			} finally {
				await gateway.cleanup();
			}
		});
	});

	describe("a rejected candidate lookup means no follower", () => {
		const rejectNext = (): Promise<never> => Promise.reject(new Error("next exploded"));

		it.each([true, false])("keeps A's healthy answer (stream=%p)", async stream => {
			const up = upstream({ [A_HOST]: () => googleAnswer("answer from A") });
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch, next: rejectNext });
			try {
				const response = await send(gateway.url, CHAT, stream);

				expect(response.status).toBe(200);
				expect(await response.text()).toContain("answer from A");
			} finally {
				await gateway.cleanup();
			}
		});

		it("keeps A's setup failure", async () => {
			const up = upstream({});
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch, next: rejectNext });
			const lookup = spyOn(gateway.storage.keys, "getWithCredential").mockRejectedValue(
				new Error("credential store offline"),
			);
			try {
				const response = await send(gateway.url, CHAT, false);
				const body = await response.text();

				expect(response.status).toBe(502);
				expect(body).toContain("credential store offline");
				expect(kinds(gateway.failures)).toEqual([[a.id, "setup_error"]]);
			} finally {
				lookup.mockRestore();
				await gateway.cleanup();
			}
		});
	});

	describe("a candidate lookup that never settles", () => {
		it.each([true, false])("ends at deadlineMs with a 502 and a deadline log (stream=%p)", async stream => {
			const called = Promise.withResolvers<void>();
			const up = upstream({ [A_HOST]: () => googleAnswer("answer from A") });
			const gateway = await startFailoverGateway({
				candidates: [a, b],
				fetch: up.fetch,
				next: () => {
					called.resolve();
					return Promise.withResolvers<undefined>().promise;
				},
			});
			const warn = spyOn(logger, "warn");
			try {
				vi.useFakeTimers();
				const pending = send(gateway.url, CHAT, stream);
				await called.promise;
				vi.advanceTimersByTime(120_000);
				const response = await pending;
				const body = await response.text();

				expect(response.status).toBe(502);
				expect(body).toContain("Gateway request deadline expired");
				expect(up.hosts()).toEqual([]);
				expect(gateway.failures).toEqual([]);
				expect(failoverLogs(warn)).toEqual([expect.objectContaining({ resolvedModel: a.id, outcome: "deadline" })]);
			} finally {
				vi.useRealTimers();
				warn.mockRestore();
				await gateway.cleanup();
			}
		});

		it("returns 499 when the client aborts", async () => {
			const called = Promise.withResolvers<void>();
			const up = upstream({ [A_HOST]: () => googleAnswer("answer from A") });
			const gateway = await startFailoverGateway({
				candidates: [a, b],
				fetch: up.fetch,
				next: () => {
					called.resolve();
					return Promise.withResolvers<undefined>().promise;
				},
			});
			const router = createAuthGatewayRouter(gateway.routeOptions);
			try {
				const client = new AbortController();
				const pending = router.route(
					new Request(`http://gateway.local${CHAT.path}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(CHAT.body("requested-model", false)),
						signal: client.signal,
					}),
					"test-peer",
					SHARED_TOKEN_CALLER,
				);
				await called.promise;
				client.abort(new Error("client went away"));
				const response = await pending;

				expect(response.status).toBe(499);
				expect(up.hosts()).toEqual([]);
			} finally {
				router.close();
				await gateway.cleanup();
			}
		});

		it("returns 499 and aborts the lookup signal when the client aborts after A failed setup", async () => {
			const called = Promise.withResolvers<FailoverContext>();
			const up = upstream({ [B_HOST]: () => googleAnswer("answer from B") });
			const gateway = await startFailoverGateway({
				candidates: [a, b],
				fetch: up.fetch,
				next: (_modelId, ctx) => {
					called.resolve(ctx);
					return Promise.withResolvers<undefined>().promise;
				},
			});
			const keys = gateway.storage.keys;
			const real = keys.getWithCredential.bind(keys);
			const lookup = spyOn(keys, "getWithCredential").mockImplementation((provider, sessionId, options) =>
				options?.modelId === a.id ? Promise.resolve(undefined) : real(provider, sessionId, options),
			);
			const router = createAuthGatewayRouter(gateway.routeOptions);
			try {
				const client = new AbortController();
				const pending = router.route(
					new Request(`http://gateway.local${CHAT.path}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(CHAT.body("requested-model", false)),
						signal: client.signal,
					}),
					"test-peer",
					SHARED_TOKEN_CALLER,
				);
				const ctx = await called.promise;
				expect(ctx.signal?.aborted).toBe(false);
				client.abort(new Error("client went away"));
				const response = await pending;

				expect(response.status).toBe(499);
				expect(ctx.signal?.aborted).toBe(true);
				expect(kinds(gateway.failures)).toEqual([[a.id, "credential_exhausted"]]);
				expect(up.hosts()).toEqual([]);
			} finally {
				lookup.mockRestore();
				router.close();
				await gateway.cleanup();
			}
		});
	});

	it("re-arms the budget for a thinking-loop redispatch that stalls after looped output", async () => {
		const up = upstream({ [B_HOST]: () => googleAnswer("answer from B") });
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		const stall = reply(a, {
			stopReason: "error",
			errorMessage: "Thinking loop detected",
			errorId: createErrorId(Flag.ThinkingLoop),
		});
		using streams = scriptStreams({
			[a.id]: (options, call) =>
				call === 1
					? handStream(a, options?.signal, [
							{ type: "start", partial: reply(a, {}) },
							{ type: "thinking_start", contentIndex: 0, partial: reply(a, {}) },
							{ type: "thinking_delta", contentIndex: 0, delta: "again and again", partial: reply(a, {}) },
							{ type: "error", reason: "error", error: stall },
						])
					: handStream(a, options?.signal, [{ type: "start", partial: reply(a, {}) }], true),
		});
		try {
			vi.useFakeTimers();
			const pending = send(gateway.url, CHAT, false);
			while (streams.options(a.id).length < 2) {
				vi.advanceTimersByTime(500);
				await settle(1);
			}
			vi.advanceTimersByTime(61_000);
			const response = await pending;
			const body = await response.text();

			expect(response.status).toBe(200);
			expect(body).toContain("answer from B");
			expect(kinds(gateway.failures)).toEqual([[a.id, "server_error"]]);
			expect(gateway.failures[0]?.failure.message).toContain("Gateway attempt budget expired");
		} finally {
			vi.useRealTimers();
			await gateway.cleanup();
		}
	});

	it.each([
		[false, b.id, b.baseUrl],
		[true, "requested-model", null],
	] as const)("names the backend in headers only once it is known (stream=%p)", async (stream, id, apiBase) => {
		const up = upstream({
			[A_HOST]: () => jsonError(503, GOOGLE_503),
			[B_HOST]: () => googleAnswer("answer from B"),
		});
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		try {
			const response = await send(gateway.url, CHAT, stream);
			expect(await response.text()).toContain("answer from B");
			expect(response.headers.get("x-litellm-model-id")).toBe(id);
			expect(response.headers.get("x-litellm-model-api-base")).toBe(apiBase);
		} finally {
			await gateway.cleanup();
		}
	});

	it("cancelling the held SSE body aborts A and starts no follower", async () => {
		const up = upstream({ [A_HOST]: init => never(init?.signal), [B_HOST]: () => googleAnswer("answer from B") });
		const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
		const router = createAuthGatewayRouter(gateway.routeOptions);
		try {
			const response = await router.route(
				new Request(`http://gateway.local${CHAT.path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(CHAT.body("requested-model", true)),
				}),
				"test-peer",
				SHARED_TOKEN_CALLER,
			);
			expect(response.status).toBe(200);
			await up.reached(A_HOST);
			await response.body?.cancel(new Error("client went away"));
			await settle();

			expect(up.calls.find(call => call.host === A_HOST)?.signal?.aborted).toBe(true);
			expect(up.count(B_HOST)).toBe(0);
			expect(gateway.failures).toEqual([]);
		} finally {
			router.close();
			await gateway.cleanup();
		}
	});

	describe("a started stream outlives deadlineMs", () => {
		it("non-streaming with a follower: A's first delta lands, then A finishes after the deadline", async () => {
			let held: HeldBody | undefined;
			const up = upstream({
				[A_HOST]: init => {
					held = heldBody(init?.signal, geminiText("answer from A"));
					return held.response;
				},
				[B_HOST]: () => googleAnswer("answer from B"),
			});
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			try {
				vi.useFakeTimers();
				const pending = send(gateway.url, CHAT, false);
				await up.reached(A_HOST);
				await held?.consumed;
				await settle();
				vi.advanceTimersByTime(121_000);
				await settle();
				held?.send(geminiFinish());
				held?.close();
				const response = await pending;

				expect(response.status).toBe(200);
				expect(await response.text()).toContain("answer from A");
				expect(up.hosts()).toEqual([A_HOST]);
				expect(gateway.failures).toEqual([]);
			} finally {
				vi.useRealTimers();
				await gateway.cleanup();
			}
		});

		it("streaming last candidate: A stays silent past the deadline, then answers", async () => {
			let held: HeldBody | undefined;
			const up = upstream({
				[A_HOST]: init => {
					held = heldBody(init?.signal, geminiText(""));
					return held.response;
				},
			});
			const gateway = await startFailoverGateway({
				candidates: [b],
				direct: { "google/candidate-a": a },
				fetch: up.fetch,
			});
			try {
				vi.useFakeTimers();
				const pending = send(gateway.url, CHAT, true, "google/candidate-a");
				await up.reached(A_HOST);
				await held?.consumed;
				await settle();
				vi.advanceTimersByTime(121_000);
				await settle();
				held?.send(geminiText("answer from A"));
				held?.send(geminiFinish());
				held?.close();
				const response = await pending;
				vi.useRealTimers();

				expect(response.status).toBe(200);
				expect(await response.text()).toContain("answer from A");
				expect(up.hosts()).toEqual([A_HOST]);
				expect(gateway.failures).toEqual([]);
			} finally {
				vi.useRealTimers();
				await gateway.cleanup();
			}
		});
	});

	it.each([true, false])(
		"treats an upstream-reported abort as today's 499 with no follower (stream=%p)",
		async stream => {
			const up = upstream({ [B_HOST]: () => googleAnswer("answer from B") });
			const gateway = await startFailoverGateway({ candidates: [a, b], fetch: up.fetch });
			const warn = spyOn(logger, "warn");
			using _streams = scriptStreams({
				[a.id]: options =>
					handStream(a, options?.signal, [
						{ type: "start", partial: reply(a, {}) },
						{
							type: "error",
							reason: "aborted",
							error: reply(a, { stopReason: "aborted", errorMessage: "Upstream cancelled the turn" }),
						},
					]),
			});
			try {
				const response = await send(gateway.url, CHAT, stream);
				const body = await response.text();

				expect(response.status).toBe(stream ? 200 : 499);
				expect(body).not.toContain("answer from B");
				expect(up.hosts()).toEqual([]);
				expect(gateway.failures).toEqual([]);
				expect(failoverLogs(warn)).toEqual([]);
			} finally {
				warn.mockRestore();
				await gateway.cleanup();
			}
		},
	);
});
