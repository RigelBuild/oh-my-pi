/**
 * omp auth-gateway router and HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → omp Context → pi-ai stream() →
 * omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 *   POST /v1/pi/stream                     → native pi-ai stream in/out
 *   POST /v1/systemone | /alpha/decisions  → TypeSafe System One judgments (routes/systemone)
 *   POST /v1/images[/generations|/edits]   → image generation, OpenAI/OpenRouter wire (routes/images)
 *   POST /v1/audio/speech                  → text-to-speech, raw audio out (routes/speech)
 *   POST /v1/audio/transcriptions          → speech-to-text, multipart or JSON base64 in (routes/transcriptions)
 *
 * Chat routes live in this file; every other modality is a `routes/*` module
 * built on the shared plumbing in `dispatch.ts`. {@link createAuthGatewayRouter}
 * answers the `/v1/*` routes for any transport: {@link startAuthGateway}
 * serves them over HTTP behind bearer auth, `stdio.ts` over JSON lines.
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { type ModelKind, modelKind } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import {
	classifyGatewayError,
	classifyUpstreamFailure,
	type GatewayErrorClassification,
	type UpstreamFailure,
} from "../error/gateway";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../types";
import type { ResolvedApiKey } from "../auth-retry";
import type { ClientUsageIdentity } from "../usage";
import { deterministicUuid } from "../utils/deterministic-id";
import { isLoopbackHost, parseBind } from "../utils/parse-bind";
import { resolvePeer } from "../utils/resolve-peer";
import { type AuthGatewayClientScope, AuthGatewayClientTable } from "./clients";
import {
	type AuthGatewayBootOptions,
	type AuthGatewayRouteOptions,
	ModelResolverUnavailableError,
	assertApiKeyLimitModelClasses,
	buildGatewayApiKeyResolver,
	type CandidateFailoverOptions,
	type FailoverContext,
	gatewayApiKeyLimitObserver,
	gatewayDroppedAttemptRecorder,
	gatewayThinkingLoopRecorder,
	observeAttemptLimitStatus,
	gatewayUsageOutcome,
	resolveGatewayModel,
	gatewayRequestLogFields,
	resolveGatewayAccount,
	resolveGatewayApiKey,
	mirrorRequestAbort,
	normalizeClientSessionKey,
	recordGatewayUsage,
} from "./dispatch";
import { gatewayLogContext, logGatewayProviderResponse, logGatewayRequestFailure } from "./logging";
import {
	armBudget,
	candidateKey,
	completeAttempt,
	endWithFailure,
	type HeldAttempt,
	holdUntilCommit,
	sseHoldBody,
} from "./failover";
import {
	callerSessionId,
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	hasMisplacedBearer,
	isCallerIdentity,
	json,
	noStoreErrorResponse,
	presentedBearer,
	resolveClientIdentity,
	SHARED_TOKEN_CALLER,
	UNAUTHENTICATED_CALLER,
	bearerTokenAuthorizer,
	withCors,
} from "./http";
import { handleEmbeddings } from "./routes/embeddings";
import { ENROLL_PATH_PREFIX, handleEnroll } from "./routes/enroll";
import { handleImageEdits, handleImageGenerations } from "./routes/images";
import { handleRerank } from "./routes/rerank";
import { handleSpeech } from "./routes/speech";
import { handleSystemOne } from "./routes/systemone";
import { handleTranscriptions } from "./routes/transcriptions";
import { handleVideoContent, handleVideoPoll, handleVideoSubmit } from "./routes/video";
import { AuthGatewaySessionStateStore, type AuthGatewaySessionStateLease } from "./session-state";
import type {
	AuthGatewayServerHandle,
	AgentCaller,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
	AuthGatewayStreamControl,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

/** A foreign chat wire the gateway translates: its codec, log label, and the pi-ai api it speaks natively. */
interface FormatRoute {
	module: FormatModule;
	label: string;
	api: Api;
}

const FORMAT_ROUTES: Record<string, FormatRoute> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat", api: "openai-completions" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages", api: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses", api: "openai-responses" },
};

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 *
 * The derivation MUST stay byte-stable: AuthStorage persists credential pins
 * under this id, so changing it re-routes every in-flight conversation.
 * `toolsJson` lets the caller share one `JSON.stringify(context.tools)` with
 * {@link AuthGatewaySessionStateStore.acquire}.
 */
function deriveSessionId(modelId: string, context: Context, toolsJson = serializeTools(context)): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (toolsJson !== undefined) {
		parts.push(toolsJson);
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (omp re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

/** `JSON.stringify(context.tools)`, or `undefined` when the request declares none. */
function serializeTools(context: Context): string | undefined {
	return context.tools && context.tools.length > 0 ? JSON.stringify(context.tools) : undefined;
}

/**
 * Fit a client-requested effort to the resolved model. Clients speak their own
 * effort vocabulary: omp's `lowest-effort` reasoning-off sends `minimal` to a
 * generic OpenAI-compatible endpoint, and Claude ladders have no `minimal`.
 * `streamSimple` throws on an effort the model cannot serve, so clamp it to the
 * nearest supported tier as in-process callers do. Efforts the model maps onto
 * its wire values, and models without an effort ladder, pass through unchanged.
 * Carry the requested tier's budget with a clamp unless the destination tier
 * already has an explicit budget (including zero).
 */
function normalizeGatewayThinking(model: Model<Api>, options: SimpleStreamOptions): void {
	const requested = options.reasoning;
	if (requested === undefined) return;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0 || efforts.includes(requested)) return;
	if (model.thinking?.effortMap?.[requested] !== undefined) return;
	if (
		model.compat &&
		"reasoningEffortMap" in model.compat &&
		model.compat.reasoningEffortMap[requested] !== undefined
	) {
		return;
	}
	const reasoning = clampThinkingLevelForModel(model, requested) ?? requested;
	options.reasoning = reasoning;
	const budgets = options.thinkingBudgets;
	if (reasoning !== requested && budgets?.[requested] !== undefined && budgets[reasoning] === undefined) {
		options.thinkingBudgets = { ...budgets, [reasoning]: budgets[requested] };
	}
}

function buildStreamOptions(parsed: ParsedFormatRequest, model: Model<Api>, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal, cursorExternalToolExecutor: true };
	const { options } = parsed;
	// Backends that reject sampling controls (Codex: `Unsupported parameter: …`, #3117)
	// get the full set stripped; everything else is harmless to forward —
	// `streamSimple` ignores what the underlying provider doesn't honour.
	const sampling = !(
		model.compat &&
		"supportsSamplingParams" in model.compat &&
		model.compat.supportsSamplingParams === false
	);
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && sampling) opts.temperature = options.temperature;
	if (options.topP !== undefined && sampling) opts.topP = options.topP;
	if (options.topK !== undefined && sampling) opts.topK = options.topK;
	if (options.minP !== undefined && sampling) opts.minP = options.minP;
	if (options.stopSequences !== undefined && sampling) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && sampling) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && sampling) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && sampling) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.userProfileId !== undefined) opts.userProfileId = options.userProfileId;
	if (options.headers !== undefined) opts.headers = { ...opts.headers, ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice !== "object"
				? options.toolChoice
				: "type" in options.toolChoice
					? options.toolChoice
					: { type: "tool", name: options.toolChoice.name };
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.forceReasoningOff !== undefined) {
		opts.disableReasoning = options.forceReasoningOff;
		opts.forceReasoningOff = options.forceReasoningOff;
	}
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.anthropicPrefixMismatchBehavior !== undefined) {
		opts.anthropicPrefixMismatchBehavior = options.anthropicPrefixMismatchBehavior;
	}
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.include !== undefined) opts.include = options.include;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey =
		normalizeClientSessionKey(options.promptCacheKey) ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...opts.thinkingBudgets, ...options.thinkingBudgets };
	}
	normalizeGatewayThinking(model, opts);
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = opts.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...opts.thinkingBudgets,
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	// Fields that don't yet have a matching pi-ai `SimpleStreamOptions` slot.
	// Surfaced once in debug logs so they show up when wiring a new provider,
	// but NEVER widened into `options.extra` — every consumer would have to
	// re-implement the typed parse to read them back out.
	// TODO(pi-ai): land first-class fields and replace these blocks.
	if (
		options.parallelToolCalls !== undefined ||
		options.previousResponseId !== undefined ||
		options.seed !== undefined ||
		options.logitBias !== undefined ||
		options.user !== undefined ||
		options.responseFormat !== undefined
	) {
		logger.debug("auth-gateway dropped unsupported typed options", {
			api: model.api,
			hasLogitBias: options.logitBias !== undefined,
			hasResponseFormat: options.responseFormat !== undefined,
		});
	}
	return opts;
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

/** Route that serves each non-chat catalog kind the gateway advertises. */
const KIND_ROUTES: Partial<Record<ModelKind, string>> = {
	judge: "POST /v1/systemone",
	image: "POST /v1/images/generations",
	tts: "POST /v1/audio/speech",
	stt: "POST /v1/audio/transcriptions",
	embedding: "POST /v1/embeddings",
	rerank: "POST /v1/rerank",
	video: "POST /v1/videos",
};

/** Chat routes cannot drive a non-chat model; name the route that does, or `undefined` for chat models. */
function chatRouteRejection(model: Model<Api>): string | undefined {
	const kind = modelKind(model);
	const route = KIND_ROUTES[kind];
	return route && `Model ${model.provider}/${model.id} is a ${kind} model; use ${route}`;
}

/** How one candidate's setup ended: a reason it cannot run, or what it runs with. */
type AttemptStart =
	| { readonly ok: false; readonly reason: "incompatible"; readonly failure: GatewayErrorClassification }
	| {
			readonly ok: false;
			readonly reason: "no_credential" | "store_error";
			readonly failure: GatewayErrorClassification;
	  }
	| {
			readonly ok: true;
			readonly streamOpts: SimpleStreamOptions;
			readonly lease: AuthGatewaySessionStateLease;
			readonly account: () => string;
			readonly resolvedKey: ResolvedApiKey;
	  };

function incompatibleAttempt(message: string): AttemptStart {
	return { ok: false, reason: "incompatible", failure: { status: 400, type: "invalid_request_error", message } };
}

/**
 * One candidate's setup on a format route: model prechecks, credential,
 * session-state lease, stream options. Throws the signal's reason when the
 * request is aborted during credential lookup, so no lease is taken for it.
 */
async function prepareFormatAttempt(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayRouteOptions,
	parsed: ParsedFormatRequest,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	peer: string,
	sessionStates: AuthGatewaySessionStateStore,
	caller: AgentCaller,
	clientKey: string | undefined,
	toolsJson: string | undefined,
	requestId: string,
): Promise<AttemptStart> {
	const kindRejection = chatRouteRejection(model);
	if (kindRejection) return incompatibleAttempt(kindRejection);
	const supportsOpenAIImageFileReferences =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	if (
		route.label === "openai-responses" &&
		!supportsOpenAIImageFileReferences &&
		parsed.context.messages.some(
			message =>
				message.role === "toolResult" &&
				message.content.some(
					block => block.type === "image" && block.providerFile?.provider === "openai" && block.providerFile.id,
				),
		)
	) {
		return incompatibleAttempt("OpenAI image file IDs in tool outputs require a Responses-compatible upstream model");
	}

	// pi-ai's stream() expects its caller to resolve and pass the API key.
	const apiKey = await resolveGatewayApiKey(
		bootOpts,
		model,
		sessionId,
		signal,
		peer,
		gatewayLogContext(requestId, caller, route.label, model.provider, model.id),
	);
	signal.throwIfAborted();
	if ("status" in apiKey) return { ok: false, reason: apiKey.setupReason, failure: apiKey };

	const streamOpts = buildStreamOptions(parsed, model, signal);
	if (bootOpts.fetch) streamOpts.fetch = bootOpts.fetch;
	const logContext = gatewayLogContext(requestId, caller, route.label, model.provider, model.id);
	const limitObserver = gatewayApiKeyLimitObserver(bootOpts, model, logContext);
	const callerOnResponse = streamOpts.onResponse;
	streamOpts.onResponse = (response, responseModel, responseSignal) => {
		logGatewayProviderResponse(logContext, response);
		limitObserver?.(response, responseModel, responseSignal);
		return callerOnResponse?.(response, responseModel, responseSignal);
	};
	let account = resolveGatewayAccount(apiKey);
	const lease = sessionStates.acquire({
		clientKey,
		agentAccountId: caller.agentAccountId,
		model,
		context: parsed.context,
		toolsJson,
		account,
		client: bootOpts.client?.name,
	});
	streamOpts.providerSessionState = lease.states;
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts,
		model,
		sessionId,
		apiKey,
		signal,
		route.label,
		peer,
		resolvedKey => {
			account = resolveGatewayAccount(resolvedKey);
			lease.updateAccount(account);
		},
		bootOpts.onUsageLimit,
		undefined,
		logContext,
	);
	return { ok: true, streamOpts, lease, account: () => account, resolvedKey: apiKey };
}

/**
 * One candidate's setup on `POST /v1/pi/stream`; see {@link prepareFormatAttempt}.
 * The client's options are trusted (already allow-listed by `parseRequest`);
 * only server-controlled fields are injected.
 */
async function preparePiNativeAttempt(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	parsed: piNative.PiNativeParsedRequest,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	peer: string,
	sessionStates: AuthGatewaySessionStateStore,
	caller: AgentCaller,
	clientKey: string | undefined,
	toolsJson: string | undefined,
	requestId: string,
): Promise<AttemptStart> {
	const kindRejection = chatRouteRejection(model);
	if (kindRejection) return incompatibleAttempt(kindRejection);

	const apiKey = await resolveGatewayApiKey(
		bootOpts,
		model,
		sessionId,
		signal,
		peer,
		gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id),
	);
	signal.throwIfAborted();
	if ("status" in apiKey) return { ok: false, reason: apiKey.setupReason, failure: apiKey };

	let account = resolveGatewayAccount(apiKey);
	const lease = sessionStates.acquire({
		clientKey,
		agentAccountId: caller.agentAccountId,
		model,
		context: parsed.context,
		toolsJson,
		account,
		client: bootOpts.client?.name,
	});
	const streamOpts: SimpleStreamOptions = {
		...parsed.options,
		signal,
		cursorExternalToolExecutor: true,
		providerSessionState: lease.states,
	};
	normalizeGatewayThinking(model, streamOpts);
	if (bootOpts.fetch) streamOpts.fetch = bootOpts.fetch;
	const logContext = gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id);
	const limitObserver = gatewayApiKeyLimitObserver(bootOpts, model, logContext);
	const callerOnResponse = streamOpts.onResponse;
	streamOpts.onResponse = (response, responseModel, responseSignal) => {
		logGatewayProviderResponse(logContext, response);
		limitObserver?.(response, responseModel, responseSignal);
		return callerOnResponse?.(response, responseModel, responseSignal);
	};
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts,
		model,
		sessionId,
		apiKey,
		signal,
		"pi-native",
		peer,
		resolvedKey => {
			account = resolveGatewayAccount(resolvedKey);
			lease.updateAccount(account);
		},
		bootOpts.onUsageLimit,
		undefined,
		logContext,
	);
	if (model.compat && "supportsSamplingParams" in model.compat && model.compat.supportsSamplingParams === false) {
		delete streamOpts.temperature;
		delete streamOpts.topP;
		delete streamOpts.topK;
		delete streamOpts.minP;
		delete streamOpts.stopSequences;
		delete streamOpts.presencePenalty;
		delete streamOpts.frequencyPenalty;
		delete streamOpts.repetitionPenalty;
	}
	const captured = captureRequestHeaders(req.headers);
	streamOpts.headers = { ...captured, ...streamOpts.headers };
	streamOpts.sessionId = sessionId;
	return { ok: true, streamOpts, lease, account: () => account, resolvedKey: apiKey };
}

const DEFAULT_FAILOVER_DEADLINE_MS = 120_000;
// Keeps one long provider Retry-After sleep from consuming most of an attempt budget the follower could use.
const FAILOVER_MAX_RETRY_DELAY_MS = 10_000;
const DEADLINE_FAILURE: GatewayErrorClassification = {
	status: 502,
	type: "upstream_error",
	message: "Gateway request deadline expired",
};
const BUDGET_MESSAGE = "Gateway attempt budget expired";

/** One chat route as the candidate loop sees it: setup per candidate, and its wire encoding. */
interface FailoverRoute {
	readonly label: string;
	readonly requestedModelId: string;
	readonly context: Context;
	readonly stream: boolean;
	formatError(status: number, type: string, message: string): Response;
	encodeResponse(message: AssistantMessage): unknown;
	encodeStream(events: AssistantMessageEventStream, control: AuthGatewayStreamControl): ReadableStream<Uint8Array>;
	prepare(model: Model<Api>, signal: AbortSignal): Promise<AttemptStart>;
}

interface FailoverRequest {
	readonly failover: CandidateFailoverOptions;
	readonly bootOpts: AuthGatewayRouteOptions;
	readonly req: Request;
	readonly controller: AbortController;
	readonly model: Model<Api>;
	readonly client: ClientUsageIdentity;
	readonly caller: AgentCaller;
	readonly peer: string;
	readonly requestId: string;
	readonly startedAt: number;
}

interface FailedOutcome {
	readonly kind: "failed";
	readonly model: Model<Api>;
	readonly failure: GatewayErrorClassification;
	/** The upstream error message, replayed as-is once headers are sent. */
	readonly error?: AssistantMessage;
}

type FailoverOutcome =
	| { readonly kind: "answered"; readonly model: Model<Api>; readonly message: AssistantMessage }
	| { readonly kind: "committed"; readonly relay: AssistantMessageEventStream }
	| FailedOutcome
	| { readonly kind: "aborted" };

/** What an attempt that produced no answer means for the client, and for failover. */
interface AttemptVerdict {
	readonly outcome: FailedOutcome | { readonly kind: "aborted" };
	/** Set only when the failure moves on to the next candidate. */
	readonly upstream?: UpstreamFailure;
}

/**
 * Abort causes are decided first: a request abort stops, a budget timeout is
 * always `server_error`, a foreign abort answers as today. Only the rest is classified.
 */
function judgeAttempt(
	model: Model<Api>,
	requestSignal: AbortSignal,
	timedOut: boolean,
	message: AssistantMessage | undefined,
	thrown: unknown,
): AttemptVerdict {
	if (requestSignal.aborted) return { outcome: { kind: "aborted" } };
	if (timedOut) {
		return {
			outcome: { kind: "failed", model, failure: { status: 502, type: "upstream_error", message: BUDGET_MESSAGE } },
			upstream: { kind: "server_error", message: BUDGET_MESSAGE },
		};
	}
	if (message === undefined) {
		const failure = classifyGatewayError(thrown);
		const outcome: FailedOutcome = { kind: "failed", model, failure };
		if (failure.status === 499) return { outcome };
		return { outcome, upstream: classifyUpstreamFailure(model, thrown, undefined, undefined) };
	}
	const errorMessage =
		message.errorMessage ?? (message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
	if (message.stopReason === "aborted") {
		return {
			outcome: { kind: "failed", model, failure: { status: 499, type: "request_aborted", message: errorMessage } },
		};
	}
	const text = message.errorClassificationMessage ?? message.errorMessage;
	const classified = classifyGatewayError(text ?? errorMessage);
	return {
		outcome: { kind: "failed", model, failure: { ...classified, message: errorMessage }, error: message },
		upstream: classifyUpstreamFailure(model, undefined, message.errorStatus, text),
	};
}

/**
 * Tries candidates in turn until one produces output. A streaming request gets
 * its 200 once the first `streamSimple` returns; the rest of the loop runs
 * behind that open body, so a later failure is written as an SSE error.
 */
function serveWithFailover(request: FailoverRequest, route: FailoverRoute): Promise<Response> {
	const { controller, requestId, startedAt } = request;
	const response = Promise.withResolvers<Response>();
	let body: PromiseWithResolvers<ReadableStream<Uint8Array>> | undefined;
	const onCancel = (reason?: unknown): void => {
		if (!controller.signal.aborted) {
			controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
		}
	};
	const control: AuthGatewayStreamControl = { signal: controller.signal, onCancel };
	// Headers can go out before the answering backend is known, so they name only the requested model.
	const streamHeaders = (model: Model<Api>): Record<string, string> => {
		const out = gatewayResponseHeaders(model, { requestId });
		out["x-litellm-model-id"] = route.requestedModelId;
		delete out["x-litellm-model-api-base"];
		return out;
	};
	const openBody = (model: Model<Api>): PromiseWithResolvers<ReadableStream<Uint8Array>> => {
		if (body) return body;
		const opened = Promise.withResolvers<ReadableStream<Uint8Array>>();
		body = opened;
		response.resolve(
			new Response(sseHoldBody(opened.promise, onCancel), {
				status: 200,
				headers: {
					...streamHeaders(model),
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				},
			}),
		);
		return opened;
	};

	void runFailoverLoop(request, route, openBody).then(
		outcome => {
			switch (outcome.kind) {
				case "answered":
					response.resolve(
						json(
							200,
							route.encodeResponse(outcome.message),
							gatewayResponseHeaders(outcome.model, {
								requestId,
								costUsd: outcome.message.usage.cost.total,
								startedAt,
							}),
						),
					);
					return;
				case "committed":
					body?.resolve(route.encodeStream(outcome.relay, control));
					return;
				case "failed": {
					if (!body) {
						response.resolve(
							route.formatError(outcome.failure.status, outcome.failure.type, outcome.failure.message),
						);
						return;
					}
					const relay = new AssistantMessageEventStream();
					if (outcome.error) {
						relay.push({
							type: "error",
							reason: outcome.error.stopReason === "aborted" ? "aborted" : "error",
							error: outcome.error,
						});
					} else {
						endWithFailure(relay, outcome.model, outcome.failure);
					}
					body.resolve(route.encodeStream(relay, control));
					return;
				}
				case "aborted":
					if (body) body.resolve(new ReadableStream({ start: stream => stream.close() }));
					else response.resolve(route.formatError(499, "request_aborted", "client closed request"));
					return;
			}
		},
		error => {
			if (body) body.reject(error);
			else response.reject(error);
		},
	);
	return response.promise;
}

// Only the answer keeps the bare request id; consumers dedupe on it, so a failed attempt's spend needs its own.
function attemptUsageId(requestId: string, attempt: number, stopReason: string): string {
	return gatewayUsageOutcome(stopReason) === "ok" ? requestId : `${requestId}:a${attempt}`;
}

async function runFailoverLoop(
	request: FailoverRequest,
	route: FailoverRoute,
	openBody: (model: Model<Api>) => void,
): Promise<FailoverOutcome> {
	const { failover, req, controller, peer, requestId, startedAt } = request;
	const deadlineAt =
		Date.now() + (failover.deadlineMs ?? DEFAULT_FAILOVER_DEADLINE_MS) - (performance.now() - startedAt);
	let expired = false;
	// Only a credential setup is cut at the deadline; a started stream never is.
	let settingUp: AbortController | undefined;
	// Aborted when the request is aborted, reaches its deadline, or ends; a pending `next` stops being awaited then.
	const lookupController = new AbortController();
	const stopLookup = Promise.withResolvers<undefined>();
	lookupController.signal.addEventListener("abort", () => stopLookup.resolve(undefined), { once: true });
	const endLookup = (): void => lookupController.abort(new Error("Candidate lookup no longer needed"));
	controller.signal.addEventListener("abort", endLookup, { once: true });
	const deadlineTimer = setTimeout(
		() => {
			expired = true;
			settingUp?.abort(new Error(DEADLINE_FAILURE.message));
			endLookup();
		},
		Math.max(0, deadlineAt - Date.now()),
	);
	const tried = new Set<string>();
	const failoverContext = (): FailoverContext => ({ req, tried: new Set(tried), signal: lookupController.signal });
	// A client that left while a lookup was pending gets the abort, not the earlier candidate's failure.
	const settleFailure = (outcome: FailedOutcome): FailoverOutcome =>
		controller.signal.aborted ? { kind: "aborted" } : outcome;
	const logAttempt = (
		attempt: number,
		model: Model<Api>,
		failure: UpstreamFailure | undefined,
		status: number | undefined,
		outcome: "retrying" | "skipped" | "exhausted" | "deadline" | "budget",
		next: Model<Api> | undefined,
	): void => {
		logger.warn("auth-gateway candidate failover", {
			requestId,
			format: route.label,
			model: model.id,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
			peer,
			attempt,
			failure: failure?.kind,
			status: failure?.status ?? status,
			...(failure?.retryAfterMs !== undefined &&
				Number.isFinite(failure.retryAfterMs) &&
				failure.retryAfterMs >= 0 && { retryAfterMs: failure.retryAfterMs }),
			elapsedMs: Math.round(performance.now() - startedAt),
			outcome,
			next: next && `${next.provider}/${next.id}`,
		});
	};
	// Reports a failed attempt; returns who goes next, or `undefined` to answer with this failure.
	const failOver = async (
		attempt: number,
		model: Model<Api>,
		failure: UpstreamFailure,
		timedOut: boolean,
		lookup: () => Promise<Model<Api> | undefined>,
	): Promise<Model<Api> | undefined> => {
		failover.onFailure(model, failure, failoverContext());
		const next = expired ? undefined : await lookup();
		const outcome = expired ? "deadline" : timedOut ? "budget" : next ? "retrying" : "exhausted";
		logAttempt(attempt, model, failure, undefined, outcome, next);
		return expired ? undefined : next;
	};
	// A rejected, stuck, or repeated lookup means no follower: the current candidate's answer or failure stands.
	const lookupNext = async (): Promise<Model<Api> | undefined> => {
		let next: Model<Api> | undefined;
		try {
			next = await Promise.race([failover.next(route.requestedModelId, failoverContext()), stopLookup.promise]);
		} catch {
			logger.warn("auth-gateway candidate lookup failed", {
				requestId,
				format: route.label,
				peer,
			});
			return undefined;
		}
		return next && !tried.has(candidateKey(next)) ? next : undefined;
	};

	let model = request.model;
	// What the client gets if no later candidate answers.
	let pending: FailedOutcome | undefined;
	try {
		for (let attempt = 1; ; attempt++) {
			if (controller.signal.aborted) return { kind: "aborted" };
			if (expired) return pending ?? { kind: "failed", model, failure: DEADLINE_FAILURE };
			tried.add(candidateKey(model));
			const attemptController = new AbortController();
			const forwardAbort = (): void => attemptController.abort(controller.signal.reason);
			controller.signal.addEventListener("abort", forwardAbort, { once: true });
			const unlink = (): void => controller.signal.removeEventListener("abort", forwardAbort);

			let start: AttemptStart;
			const setupCut = Promise.withResolvers<never>();
			const cutSetup = (): void => setupCut.reject(attemptController.signal.reason);
			attemptController.signal.addEventListener("abort", cutSetup, { once: true });
			settingUp = attemptController;
			try {
				start = await Promise.race([route.prepare(model, attemptController.signal), setupCut.promise]);
			} catch (error) {
				unlink();
				if (controller.signal.aborted) return { kind: "aborted" };
				const failure = expired ? DEADLINE_FAILURE : classifyGatewayError(error);
				const failed: FailedOutcome = { kind: "failed", model, failure };
				const upstream: UpstreamFailure = { kind: "setup_error", status: failure.status, message: failure.message };
				const next = await failOver(attempt, model, upstream, false, lookupNext);
				if (!next) return settleFailure(failed);
				pending = failed;
				model = next;
				continue;
			} finally {
				settingUp = undefined;
				attemptController.signal.removeEventListener("abort", cutSetup);
			}

			if (!start.ok) {
				unlink();
				const failed: FailedOutcome = { kind: "failed", model, failure: start.failure };
				if (start.reason === "incompatible") {
					// The first candidate fails as today; a follower that cannot serve this route is passed over.
					if (attempt === 1) return failed;
					const next = await lookupNext();
					logAttempt(attempt, model, undefined, start.failure.status, "skipped", next);
					if (!next) return settleFailure(pending ?? failed);
					model = next;
					continue;
				}
				const upstream: UpstreamFailure = {
					kind: start.reason === "no_credential" ? "credential_exhausted" : "setup_error",
					status: start.failure.status,
					message: start.failure.message,
				};
				const next = await failOver(attempt, model, upstream, false, lookupNext);
				if (!next) return settleFailure(failed);
				pending = failed;
				model = next;
				continue;
			}

			const { streamOpts, lease, account } = start;
			const follower = await lookupNext();
			if (controller.signal.aborted || expired) {
				lease.release();
				unlink();
				if (controller.signal.aborted) return { kind: "aborted" };
				logAttempt(attempt, model, undefined, DEADLINE_FAILURE.status, "deadline", undefined);
				return pending ?? { kind: "failed", model, failure: DEADLINE_FAILURE };
			}
			// Capped only when a follower can take over; a last candidate keeps today's retry hints.
			if (follower) {
				const requested = streamOpts.maxRetryDelayMs;
				// Zero or less disables the provider cap, so only a positive client value may lower ours.
				streamOpts.maxRetryDelayMs =
					requested !== undefined && requested > 0
						? Math.min(requested, FAILOVER_MAX_RETRY_DELAY_MS)
						: FAILOVER_MAX_RETRY_DELAY_MS;
			}
			const budget = armBudget(
				attemptController,
				follower ? Date.now() + Math.max(0, (deadlineAt - Date.now()) / 2) : undefined,
			);
			const answering = model;
			streamOpts.onDroppedAttempt = gatewayDroppedAttemptRecorder(
				request.bootOpts,
				answering,
				request.client,
				`${requestId}:a${attempt}`,
				gatewayLogContext(requestId, request.caller, route.label, answering.provider, answering.id),
			);
			const loop = gatewayThinkingLoopRecorder(
				request.bootOpts,
				answering,
				request.client,
				`${requestId}:a${attempt}`,
			);
			const knownFollower = async (): Promise<Model<Api> | undefined> => follower;
			logger.info("auth-gateway request", {
				requestId,
				format: route.label,
				model: answering.id,
				resolvedProvider: answering.provider,
				resolvedModel: answering.id,
				stream: route.stream,
				peer,
			});

			// A synchronous `streamSimple` throw is a setup failure on either path, never classified as upstream.
			const setupThrew = async (error: unknown): Promise<FailoverOutcome | Model<Api>> => {
				budget.settle();
				lease.release();
				unlink();
				const failure = classifyGatewayError(error);
				const upstream: UpstreamFailure = { kind: "setup_error", status: failure.status, message: failure.message };
				const failed: FailedOutcome = { kind: "failed", model: answering, failure };
				const next = await failOver(attempt, answering, upstream, false, knownFollower);
				if (!next) return settleFailure(failed);
				pending = failed;
				return next;
			};

			let verdict: AttemptVerdict;
			if (!route.stream) {
				let attemptResult: Promise<AssistantMessage>;
				try {
					attemptResult = completeAttempt(answering, route.context, streamOpts, budget, loop.onAttempt);
				} catch (error) {
					const next = await setupThrew(error);
					if (!("api" in next)) return next;
					model = next;
					continue;
				}
				let message: AssistantMessage | undefined;
				let thrown: unknown;
				try {
					message = await attemptResult;
				} catch (error) {
					thrown = error;
				} finally {
					loop.settle(message);
					lease.release();
					unlink();
				}
				if (message) {
					observeAttemptLimitStatus(request.bootOpts.storage, answering.provider, message.credentialId, message);
					recordGatewayUsage(request.bootOpts, answering, request.client, message.usage, {
						requestId: attemptUsageId(requestId, attempt, message.stopReason),
						outcome: gatewayUsageOutcome(message.stopReason),
						at: message.timestamp || undefined,
						account: account(),
						credentialId: message.credentialId,
					});
					if (message.stopReason !== "error" && message.stopReason !== "aborted") {
						return { kind: "answered", model: answering, message };
					}
				}
				verdict = judgeAttempt(answering, controller.signal, budget.timedOut(), message, thrown);
			} else {
				let events: AssistantMessageEventStream;
				try {
					events = streamSimple(answering, route.context, streamOpts);
				} catch (error) {
					const next = await setupThrew(error);
					if (!("api" in next)) return next;
					model = next;
					continue;
				}
				openBody(answering);
				void events
					.result()
					.then(message => {
						observeAttemptLimitStatus(
							request.bootOpts.storage,
							answering.provider,
							message.credentialId,
							message,
						);
						recordGatewayUsage(request.bootOpts, answering, request.client, message.usage, {
							requestId: attemptUsageId(requestId, attempt, message.stopReason),
							outcome: gatewayUsageOutcome(message.stopReason),
							at: message.timestamp || undefined,
							account: account(),
							credentialId: message.credentialId,
						});
					})
					.catch(() => {})
					.finally(() => {
						lease.release();
						unlink();
					});
				let held: HeldAttempt | undefined;
				let thrown: unknown;
				try {
					held = await holdUntilCommit(events, budget);
				} catch (error) {
					thrown = error;
				}
				if (held?.kind === "committed") return { kind: "committed", relay: held.relay };
				// An attempt that stopped holding without committing must not keep streaming beside the next one.
				attemptController.abort(new Error("Gateway attempt abandoned before commit"));
				verdict = judgeAttempt(answering, controller.signal, budget.timedOut(), held?.error, thrown);
			}

			if (verdict.outcome.kind === "aborted") return verdict.outcome;
			if (!verdict.upstream) {
				// A terminal stop still gets its log line; an abort reported by the upstream does not.
				if (verdict.outcome.failure.status !== 499) {
					logAttempt(attempt, answering, undefined, verdict.outcome.failure.status, "exhausted", undefined);
				}
				return verdict.outcome;
			}
			const next = await failOver(attempt, answering, verdict.upstream, budget.timedOut(), knownFollower);
			if (!next) return settleFailure(verdict.outcome);
			pending = verdict.outcome;
			model = next;
		}
	} finally {
		clearTimeout(deadlineTimer);
		controller.signal.removeEventListener("abort", endLookup);
		endLookup();
	}
}

// (handlePassthrough removed — see note above.)

async function handleFormatEndpoint(
	route: FormatRoute,
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	sessionStates: AuthGatewaySessionStateStore,
	caller: AgentCaller,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}

	const model = await resolveGatewayModel(bootOpts.resolveModel, modelId, caller, { api: route.api });
	if (controller.signal.aborted) return clientClosedResponse(route);
	if (!model) {
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}
	// Checked here too, ahead of parsing, so a non-chat model with a bad body
	// still gets the kind error; the attempt repeats it for each candidate.
	const kindRejection = chatRouteRejection(model);
	if (kindRejection) return route.module.formatError(400, "invalid_request_error", kindRejection);
	const client = resolveClientIdentity(req.headers);

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
		if (route.module === openaiChat) openaiChat.adoptReplayedGeminiSignatures(parsed.context, model);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	for (const message of parsed.context.messages) {
		if (message.role === "assistant" && message.model === modelId) {
			message.model = model.id;
			message.provider = model.provider;
		}
	}
	// Merge gateway-captured passthrough headers under the parser's own
	// captures. Parsers that set `options.headers` themselves win (they may
	// have stripped or normalized values); the gateway's allow-list fills in
	// anything they didn't touch.
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...parsed.options.headers };
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// Sticky credential id: honour the client's `prompt_cache_key` when
	// supplied (so external session ids align), otherwise derive from
	// modelId + system + tools + first message. Mirrored into
	// streamOpts.sessionId / promptCacheKey by `buildStreamOptions`.
	const clientKey = normalizeClientSessionKey(parsed.options.promptCacheKey);
	const toolsJson = clientKey === undefined ? serializeTools(parsed.context) : undefined;
	const sessionId = callerSessionId(caller, clientKey ?? deriveSessionId(parsed.modelId, parsed.context, toolsJson));
	parsed.options.promptCacheKey = sessionId;
	if (bootOpts.candidateFailover) {
		return serveWithFailover(
			{
				failover: bootOpts.candidateFailover,
				bootOpts,
				req,
				controller,
				model,
				client,
				caller,
				peer,
				requestId,
				startedAt,
			},
			{
				label: route.label,
				requestedModelId: parsed.modelId,
				context: parsed.context,
				stream: parsed.stream,
				formatError: (status, type, message) => route.module.formatError(status, type, message),
				encodeResponse: message => route.module.encodeResponse(message, parsed.modelId),
				encodeStream: (events, control) =>
					route.module.encodeStream(events, parsed.modelId, parsed.options, control),
				prepare: (candidate, signal) =>
					prepareFormatAttempt(
						route,
						bootOpts,
						parsed,
						candidate,
						sessionId,
						signal,
						peer,
						sessionStates,
						caller,
						clientKey,
						toolsJson,
						requestId,
					),
			},
		);
	}

	let start: AttemptStart;
	try {
		start = await prepareFormatAttempt(
			route,
			bootOpts,
			parsed,
			model,
			sessionId,
			controller.signal,
			peer,
			sessionStates,
			caller,
			clientKey,
			toolsJson,
			requestId,
		);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		throw error;
	}
	if (!start.ok) return route.module.formatError(start.failure.status, start.failure.type, start.failure.message);
	const { streamOpts, lease, account, resolvedKey: apiKey } = start;
	streamOpts.onDroppedAttempt = gatewayDroppedAttemptRecorder(
		bootOpts,
		model,
		client,
		requestId,
		gatewayLogContext(requestId, caller, route.label, model.provider, model.id),
	);

	logger.info("auth-gateway request", {
		requestId,
		format: route.label,
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
		...gatewayRequestLogFields(bootOpts, apiKey),
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const loop = gatewayThinkingLoopRecorder(bootOpts, model, client, requestId);
			let message: AssistantMessage | undefined;
			try {
				message = await completeSimple(model, parsed.context, { ...streamOpts, onAttempt: loop.onAttempt });
			} finally {
				loop.settle(message);
			}
			observeAttemptLimitStatus(bootOpts.storage, model.provider, message.credentialId, message);
			recordGatewayUsage(bootOpts, model, client, message.usage, {
				requestId,
				outcome: gatewayUsageOutcome(message.stopReason),
				at: message.timestamp || undefined,
				account: account(),
				credentialId: message.credentialId,
			});
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logGatewayRequestFailure(
					gatewayLogContext(requestId, caller, route.label, model.provider, model.id),
					message.errorStatus,
					message.credentialId,
				);
				if (message.stopReason === "aborted") {
					return route.module.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
				return route.module.formatError(classified.status, classified.type, errorMessage);
			}
			return json(
				200,
				route.module.encodeResponse(message, parsed.modelId),
				gatewayResponseHeaders(model, { requestId, costUsd: message.usage.cost.total, startedAt }),
			);
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const classified = classifyGatewayError(error);
			logGatewayRequestFailure(
				gatewayLogContext(requestId, caller, route.label, model.provider, model.id),
				classified.status,
			);
			return route.module.formatError(classified.status, classified.type, classified.message);
		} finally {
			// Every non-streaming outcome — answered, upstream error, thrown,
			// client gone — is done with the provider state here.
			lease.release();
		}
	}

	// A streamed turn outlives this function, so the lease, and a scoped
	// client's hold on its account restriction, travel with the event stream and
	// are released when the turn settles. Until that handoff happens, the
	// `finally` below owns them.
	const clientHold = bootOpts.client?.retain();
	const settle = (): void => {
		lease.release();
		clientHold?.();
	};
	let streamOwnsLease = false;
	try {
		let events: AssistantMessageEventStream;
		try {
			if (controller.signal.aborted) return clientClosedResponse(route);
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logGatewayRequestFailure(
				gatewayLogContext(requestId, caller, route.label, model.provider, model.id),
				classified.status,
			);
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
		if (controller.signal.aborted) return clientClosedResponse(route);
		void events
			.result()
			.then(message => {
				if (message.stopReason === "error")
					logGatewayRequestFailure(
						gatewayLogContext(requestId, caller, route.label, model.provider, model.id),
						message.errorStatus,
						message.credentialId,
					);
				observeAttemptLimitStatus(bootOpts.storage, model.provider, message.credentialId, message);
				recordGatewayUsage(bootOpts, model, client, message.usage, {
					requestId,
					outcome: gatewayUsageOutcome(message.stopReason),
					at: message.timestamp || undefined,
					account: account(),
					credentialId: message.credentialId,
				});
			})
			.catch(() => {})
			.finally(settle);
		streamOwnsLease = true;

		const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		});
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				// Disable proxy buffering (nginx and ingress controllers honor this).
				// Without it the SSE stream gets held until the buffer flushes, which
				// stalls the long-thinking-budget calls we exist to support.
				"X-Accel-Buffering": "no",
			},
		});
	} finally {
		if (!streamOwnsLease) settle();
	}
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNative(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	sessionStates: AuthGatewaySessionStateStore,
	caller: AgentCaller,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => noStoreErrorResponse(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return noStoreErrorResponse(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return noStoreErrorResponse(400, "invalid_request_error", message);
	}

	const model = await resolveGatewayModel(bootOpts.resolveModel, parsed.modelId, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) {
		return noStoreErrorResponse(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	const kindRejection = chatRouteRejection(model);
	if (kindRejection) return noStoreErrorResponse(400, "invalid_request_error", kindRejection);
	const client = resolveClientIdentity(req.headers);
	// Pi-native already parsed `streamOpts.sessionId` (when set by the
	// client); fall back to the derived key so credential-stickiness lines
	// up with cache-prefix stickiness — same identity used for both means
	// the next turn of this conversation reuses the same credential until
	// it hits a usage cap, then markUsageLimitReached can hand off.
	const clientKey = normalizeClientSessionKey(parsed.options.sessionId);
	const toolsJson = clientKey === undefined ? serializeTools(parsed.context) : undefined;
	const sessionId = callerSessionId(caller, clientKey ?? deriveSessionId(parsed.modelId, parsed.context, toolsJson));
	parsed.options.sessionId = sessionId;
	const clientCacheKey = normalizeClientSessionKey(parsed.options.promptCacheKey);
	if (clientCacheKey !== undefined) parsed.options.promptCacheKey = callerSessionId(caller, clientCacheKey);
	if (bootOpts.candidateFailover) {
		return serveWithFailover(
			{
				failover: bootOpts.candidateFailover,
				bootOpts,
				req,
				controller,
				model,
				client,
				caller,
				peer,
				requestId,
				startedAt,
			},
			{
				label: "pi-native",
				requestedModelId: parsed.modelId,
				context: parsed.context,
				stream: parsed.stream,
				formatError: piNative.formatError,
				encodeResponse: message => ({ message }),
				encodeStream: (events, control) => piNative.encodeStream(events, parsed.modelId, parsed.options, control),
				prepare: (candidate, signal) =>
					preparePiNativeAttempt(
						bootOpts,
						req,
						parsed,
						candidate,
						sessionId,
						signal,
						peer,
						sessionStates,
						caller,
						clientKey,
						toolsJson,
						requestId,
					),
			},
		);
	}

	let start: AttemptStart;
	try {
		start = await preparePiNativeAttempt(
			bootOpts,
			req,
			parsed,
			model,
			sessionId,
			controller.signal,
			peer,
			sessionStates,
			caller,
			clientKey,
			toolsJson,
			requestId,
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		throw error;
	}
	if (!start.ok) return piNative.formatError(start.failure.status, start.failure.type, start.failure.message);
	const { streamOpts, lease, account, resolvedKey: apiKey } = start;
	streamOpts.onDroppedAttempt = gatewayDroppedAttemptRecorder(
		bootOpts,
		model,
		client,
		requestId,
		gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id),
	);

	logger.info("auth-gateway request", {
		requestId,
		format: "pi-native",
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
		...gatewayRequestLogFields(bootOpts, apiKey),
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return aborted();
			const loop = gatewayThinkingLoopRecorder(bootOpts, model, client, requestId);
			let message: AssistantMessage | undefined;
			try {
				message = await completeSimple(model, parsed.context, { ...streamOpts, onAttempt: loop.onAttempt });
			} finally {
				loop.settle(message);
			}
			observeAttemptLimitStatus(bootOpts.storage, model.provider, message.credentialId, message);
			recordGatewayUsage(bootOpts, model, client, message.usage, {
				requestId,
				outcome: gatewayUsageOutcome(message.stopReason),
				at: message.timestamp || undefined,
				account: account(),
				credentialId: message.credentialId,
			});
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logGatewayRequestFailure(
					gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id),
					message.errorStatus,
					message.credentialId,
				);
				if (message.stopReason === "aborted") {
					return noStoreErrorResponse(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
				return noStoreErrorResponse(classified.status, classified.type, errorMessage);
			}
			return json(
				200,
				{ message },
				gatewayResponseHeaders(model, { requestId, costUsd: message.usage.cost.total, startedAt }),
			);
		} catch (error) {
			if (controller.signal.aborted) return aborted();
			const classified = classifyGatewayError(error);
			logGatewayRequestFailure(
				gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id),
				classified.status,
			);
			return noStoreErrorResponse(classified.status, classified.type, classified.message);
		} finally {
			// Every non-streaming outcome — answered, upstream error, thrown,
			// client gone — is done with the provider state here.
			lease.release();
		}
	}

	// A streamed turn outlives this function, so the lease, and a scoped
	// client's hold on its account restriction, travel with the event stream and
	// are released when the turn settles. Until that handoff happens, the
	// `finally` below owns them.
	const clientHold = bootOpts.client?.retain();
	const settle = (): void => {
		lease.release();
		clientHold?.();
	};
	let streamOwnsLease = false;
	try {
		let events: AssistantMessageEventStream;
		try {
			if (controller.signal.aborted) return aborted();
			events = streamSimple(model, parsed.context, streamOpts);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logGatewayRequestFailure(
				gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id),
				classified.status,
			);
			return noStoreErrorResponse(classified.status, classified.type, classified.message);
		}
		if (controller.signal.aborted) return aborted();
		void events
			.result()
			.then(message => {
				if (message.stopReason === "error")
					logGatewayRequestFailure(
						gatewayLogContext(requestId, caller, "pi-native", model.provider, model.id),
						message.errorStatus,
						message.credentialId,
					);
				observeAttemptLimitStatus(bootOpts.storage, model.provider, message.credentialId, message);
				recordGatewayUsage(bootOpts, model, client, message.usage, {
					requestId,
					outcome: gatewayUsageOutcome(message.stopReason),
					at: message.timestamp || undefined,
					account: account(),
					credentialId: message.credentialId,
				});
			})
			.catch(() => {})
			.finally(settle);
		streamOwnsLease = true;

		const sseStream = piNative.encodeStream(events, parsed.modelId, parsed.options, {
			signal: controller.signal,
			onCancel: reason => {
				if (!controller.signal.aborted) {
					controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
				}
			},
		});
		return new Response(sseStream, {
			status: 200,
			headers: {
				...gatewayResponseHeaders(model, { requestId }),
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	} finally {
		if (!streamOwnsLease) settle();
	}
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(opts: AuthGatewayRouteOptions, signal: AbortSignal): Promise<Response> {
	const reports = (await opts.storage.usage.reports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports
		.filter(report => !opts.excludeProviders?.has(report.provider))
		.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(opts: AuthGatewayRouteOptions, signal: AbortSignal): Promise<Response> {
	const credentials = await opts.storage.health.check({ signal, excludeProviders: opts.excludeProviders });
	return json(200, { generatedAt: Date.now(), credentials });
}

/**
 * Row shape for `GET /v1/models`. Beyond the OpenAI-standard `id`/`object`/
 * `owned_by`, rows advertise the catalog metadata OpenAI-compatible clients
 * (omp's own proxy discovery, Zed's openai_compatible provider, ...) read to
 * size and capability-gate discovered models: `context_length`,
 * `max_output_tokens`, `input_modalities`, and `supports_tools` (only emitted
 * when the catalog explicitly reports `false`; absent means usable). `kind` is
 * emitted for non-chat rows (`judge`, `image`, `tts`, `stt`, `embedding`,
 * `rerank`, `video`) so clients can keep them off chat routes; absent means chat.
 */
interface ModelListRow {
	id: string;
	object: "model";
	owned_by: string;
	api: Api;
	kind?: ModelKind;
	display_name: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities: ("text" | "image")[];
	supports_tools?: boolean;
}

function handleModelsList(opts: AuthGatewayRouteOptions): Response {
	const seen = new Set<string>();
	const data: ModelListRow[] = [];
	const append = (id: string, model: Model<Api>) => {
		if (seen.has(id)) return;
		seen.add(id);
		const row: ModelListRow = {
			id,
			object: "model",
			owned_by: model.provider,
			api: model.api,
			display_name: model.name,
			input_modalities: model.input,
		};
		if (modelKind(model) !== "chat") row.kind = modelKind(model);
		if (model.contextWindow != null) row.context_length = model.contextWindow;
		if (model.maxTokens != null) row.max_output_tokens = model.maxTokens;
		if (model.supportsTools === false) row.supports_tools = false;
		data.push(row);
	};
	for (const model of opts.listModels?.() ?? []) {
		append(`${model.provider}/${model.id}`, model);
	}
	for (const alias of opts.listAliases?.() ?? []) {
		append(alias.id, alias.model);
	}

	return json(200, { object: "list", data });
}

/** `GET /v1/videos/:id` (poll) and `GET /v1/videos/:id/content` (download); group 1 = id, group 2 = `/content`. */
const VIDEO_JOB_PATH = /^\/v1\/videos\/([^/]+)(\/content)?$/;

// Only exact static routes are safe to include in unauthorized request logs.
// Dynamic video IDs and unknown paths may carry credentials.
const LOGGABLE_PATHS: Record<string, true> = {
	"/v1/usage": true,
	"/v1/credentials/check": true,
	"/v1/pi/stream": true,
	"/v1/systemone": true,
	"/alpha/decisions": true,
	"/v1/images/generations": true,
	"/v1/images": true,
	"/v1/images/edits": true,
	"/v1/audio/speech": true,
	"/v1/audio/transcriptions": true,
	"/v1/embeddings": true,
	"/v1/rerank": true,
	"/v1/videos": true,
	"/v1/models": true,
	"/internal/enroll/providers": true,
	"/internal/enroll/authorize-url": true,
	"/internal/enroll/exchange": true,
};

/** Only static routes reach logs verbatim; dynamic or unknown paths may carry caller-supplied secrets. */
function loggablePath(pathname: string): string {
	return Object.hasOwn(FORMAT_ROUTES, pathname) || Object.hasOwn(LOGGABLE_PATHS, pathname) ? pathname : "<unrouted>";
}

/** An injected callback's error class, never its message, which may echo a credential. */
function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

/** The gateway's `/v1/*` routes, for a transport that has admitted the caller. */
export interface AuthGatewayRouter {
	/** Route one admitted request with its agent and optional scoped client. */
	route(req: Request, peer: string, caller: AgentCaller, client?: AuthGatewayClientScope): Promise<Response>;
	/** Close retained provider session state owned by the router. */
	close(): void;
}

/** Why scoped clients cannot read gateway-wide account data. */
const GATEWAY_WIDE_ROUTE = "client tokens cannot read gateway-wide usage or credential health";

/** Narrow model resolution and listings to one admitted client. */
function scopeRouteOptions(opts: AuthGatewayRouteOptions, client: AuthGatewayClientScope): AuthGatewayRouteOptions {
	if (!client.limitsModels) return { ...opts, client };
	const { resolveModel, listModels, listAliases } = opts;
	return {
		...opts,
		client,
		resolveModel: async (id, options) => {
			const accepts = (model: Model<Api>): boolean => client.allows(model) && (options?.accepts?.(model) ?? true);
			const model = await resolveModel(id, { ...options, accepts });
			return model && accepts(model) ? model : undefined;
		},
		listModels: listModels && (() => [...listModels()].filter(model => client.allows(model))),
		listAliases: listAliases && (() => [...listAliases()].filter(alias => client.allows(alias.model))),
	};
}
/**
 * The gateway's routes over host options, owning their per-session provider state.
 */
export function createAuthGatewayRouter(hostOpts: AuthGatewayRouteOptions): AuthGatewayRouter {
	assertApiKeyLimitModelClasses(hostOpts.apiKeyLimitModelClasses);
	const sessionStates = new AuthGatewaySessionStateStore();
	const route = async (
		req: Request,
		peer: string,
		caller: AgentCaller,
		client?: AuthGatewayClientScope,
	): Promise<Response> => {
		const pathname = new URL(req.url).pathname;
		const body = async (): Promise<Response> => {
			const opts = client ? scopeRouteOptions(hostOpts, client) : hostOpts;
			if (req.method === "GET" && pathname === "/v1/models") return handleModelsList(opts);
			let scoped = opts;
			if (hostOpts.resolveStorage) {
				try {
					scoped = { ...opts, storage: await hostOpts.resolveStorage(caller) };
				} catch (error) {
					logger.warn("auth-gateway credential pool unavailable", {
						path: loggablePath(pathname),
						peer,
						error: errorName(error),
					});
					return json(503, { error: "credential pool unavailable" });
				}
				if (req.signal.aborted) return new Response(null, { status: 499 });
			}
			if (req.method === "GET" && pathname === "/v1/usage") {
				if (client) return json(403, { error: GATEWAY_WIDE_ROUTE });
				return handleUsage(scoped, req.signal);
			}
			if (req.method === "GET" && pathname === "/v1/credentials/check") {
				if (client) return json(403, { error: GATEWAY_WIDE_ROUTE });
				return handleCredentialsCheck(scoped, req.signal);
			}
			const formatRoute = FORMAT_ROUTES[pathname];
			if (formatRoute && req.method === "POST") {
				return handleFormatEndpoint(formatRoute, scoped, req, peer, sessionStates, caller);
			}
			if (req.method === "POST" && pathname === "/v1/pi/stream") {
				return handlePiNative(scoped, req, peer, sessionStates, caller);
			}
			if (req.method === "POST" && (pathname === "/v1/systemone" || pathname === "/alpha/decisions")) {
				return handleSystemOne(scoped, req, peer, caller);
			}
			if (req.method === "POST" && (pathname === "/v1/images/generations" || pathname === "/v1/images")) {
				return handleImageGenerations(scoped, req, peer, caller);
			}
			if (req.method === "POST" && pathname === "/v1/images/edits") {
				return handleImageEdits(scoped, req, peer, caller);
			}
			if (req.method === "POST" && pathname === "/v1/audio/speech") {
				return handleSpeech(scoped, req, peer, caller);
			}
			if (req.method === "POST" && pathname === "/v1/audio/transcriptions") {
				return handleTranscriptions(scoped, req, peer, caller);
			}
			if (req.method === "POST" && pathname === "/v1/embeddings") {
				return handleEmbeddings(scoped, req, peer, caller);
			}
			if (req.method === "POST" && pathname === "/v1/rerank") {
				return handleRerank(scoped, req, peer, caller);
			}
			if (req.method === "POST" && pathname === "/v1/videos") {
				return handleVideoSubmit(scoped, req, peer, caller);
			}
			const videoJob = req.method === "GET" ? VIDEO_JOB_PATH.exec(pathname) : null;
			if (videoJob) {
				const gatewayId = decodeURIComponent(videoJob[1]);
				const handler = videoJob[2] ? handleVideoContent : handleVideoPoll;
				return handler(scoped, req, peer, gatewayId, caller);
			}
			return json(404, { error: `No route: ${req.method} ${pathname}` });
		};
		try {
			return hostOpts.routeScope ? await hostOpts.routeScope(req, body) : await body();
		} catch (error) {
			if (error instanceof ModelResolverUnavailableError) {
				logger.warn("auth-gateway model resolver unavailable", {
					path: loggablePath(pathname),
					peer,
					cause: errorName(error.cause),
				});
				return json(503, { error: "model resolver unavailable" });
			}
			logger.error("auth-gateway handler crashed", {
				method: req.method,
				path: loggablePath(pathname),
				peer,
			});
			return json(500, { error: "internal error" });
		}
	};
	return { route, close: () => sessionStates.close() };
}

/** Enrollment routes for an admitted enroll caller. Never rejects: a crash answers 500 and logs only its class. */
async function enrollRoute(
	req: Request,
	pathname: string,
	fetchImpl: AuthGatewayRouteOptions["fetch"],
): Promise<Response> {
	try {
		return await handleEnroll(req, pathname, fetchImpl);
	} catch (error) {
		logger.error("auth-gateway enrollment route crashed", { path: loggablePath(pathname), error: errorName(error) });
		return json(500, { error: "internal error" });
	}
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens ?? []);
	const authorize = opts.authorize ?? bearerTokenAuthorizer(tokens);
	if (
		opts.authorize === undefined &&
		tokens.size === 0 &&
		opts.clients === undefined &&
		!isLoopbackHost(bind.hostname)
	) {
		throw new Error("auth-gateway: empty bearer token set is allowed only on a loopback bind");
	}
	const clients = new AuthGatewayClientTable(opts.storage.sessions, tokens);
	if (opts.clients) clients.set(opts.clients);
	const version = opts.version;
	const router = createAuthGatewayRouter(opts);
	let requireBearer = opts.clients !== undefined;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req, server): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const socketPeer = server.requestIP(req)?.address ?? "unknown";
			if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
			if (req.method === "GET" && pathname === "/healthz") {
				return withCors(json(200, { ok: true, version }), req);
			}

			const bearer = presentedBearer(req);
			let admitted: unknown;
			let client: AuthGatewayClientScope | undefined;
			try {
				client = bearer === undefined ? undefined : clients.authenticate(bearer);
				admitted = client ? SHARED_TOKEN_CALLER : await authorize(req);
			} catch (error) {
				logger.warn("auth-gateway authorizer failed", {
					method: req.method,
					path: loggablePath(pathname),
					peer: socketPeer,
					error: errorName(error),
				});
				return withCors(json(503, { error: "authorization unavailable" }), req);
			}
			if (
				!isCallerIdentity(admitted) ||
				(bearer === undefined && admitted !== UNAUTHENTICATED_CALLER) ||
				(requireBearer && admitted === UNAUTHENTICATED_CALLER) ||
				(admitted.kind === "enroll") !== pathname.startsWith(ENROLL_PATH_PREFIX)
			) {
				logger.info("auth-gateway request unauthorized", {
					method: req.method,
					path: loggablePath(pathname),
					peer: socketPeer,
				});
				return withCors(json(401, { error: "unauthorized" }), req);
			}
			let misplacedBearer = bearer !== undefined && hasMisplacedBearer(req, url, bearer);
			if (!misplacedBearer) {
				for (const token of tokens) {
					if (token !== bearer && hasMisplacedBearer(req, url, token)) {
						misplacedBearer = true;
						break;
					}
				}
			}
			if (misplacedBearer) {
				return withCors(json(400, { error: "gateway bearer token outside Authorization" }), req);
			}
			if (req.signal.aborted) return new Response(null, { status: 499 });
			if (admitted.kind === "enroll") return enrollRoute(req, pathname, opts.fetch);
			const peer = resolvePeer(req, socketPeer, opts.trustProxyHeaders);
			if (client) {
				const release = client.retain();
				try {
					return withCors(await router.route(req, peer, admitted, client), req);
				} finally {
					release();
				}
			}
			return withCors(await router.route(req, peer, admitted), req);
		},
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async (drainMs?: number) => {
			if (drainMs === undefined) {
				await server.stop(true);
			} else if (!Number.isFinite(drainMs)) {
				throw new RangeError("drainMs must be a finite duration no greater than 2147483647 ms");
			} else if (drainMs <= 0) {
				await server.stop(true);
			} else {
				if (drainMs > 2_147_483_647) {
					throw new RangeError("drainMs must be a finite duration no greater than 2147483647 ms");
				}
				const deadline = setTimeout(() => void server.stop(true), drainMs);
				try {
					await server.stop();
				} finally {
					clearTimeout(deadline);
				}
			}
			router.close();
			clients.close();
		},
		setClients: list => {
			clients.set(list);
			requireBearer = true;
		},
	};
}
