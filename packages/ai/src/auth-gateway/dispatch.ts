/**
 * Per-request plumbing shared by every auth-gateway route.
 *
 * A route module (`server.ts` chat/pi-native handlers, `routes/*.ts` for
 * judgments, images, speech, transcription, …) owns only its wire format:
 * parse the body, pick a model, call the pi-ai client, encode the reply.
 * Everything credential-shaped lives here so each route drives the same
 * broker-backed rotation policy and the same usage ledger.
 */
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { extractHttpStatusFromError, logger } from "@oh-my-pi/pi-utils";
import { markAfterSiblingWait, type ApiKeyResolver, type ResolvedApiKey } from "../auth-retry";
import type { AuthApiKeyOptions, AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError, type GatewayErrorClassification, type UpstreamFailure } from "../error/gateway";
import {
	calculateRateLimitBackoffMs,
	isAnthropicCreditBalanceTooLow,
	isUsageLimitOutcome,
	observedLimitErrorStatus,
} from "../error/rate-limit";
import { emptyUsage } from "../images/shared";
import type { Api, AssistantMessage, FetchImpl, Model, StreamOptions, Usage } from "../types";
import type { ClientUsageIdentity } from "../usage";
import { parseAnthropicApiKeyRateLimitHeaders } from "../usage/anthropic-api";
import { extractProviderRetryHint } from "../utils/retry-after";
import type { AgentCaller, AuthGatewayServerOptions, CallerIdentity } from "./types";

export type ModelResolver = (
	modelId: string,
	/** The admitted request identity used to resolve against the caller's credential pool. */
	caller: CallerIdentity,
) => Model<Api> | undefined | Promise<Model<Api> | undefined>;

export class ModelResolverUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super("model resolver unavailable", options);
		this.name = "ModelResolverUnavailableError";
	}
}

export async function resolveGatewayModel(
	resolver: ModelResolver,
	modelId: string,
	caller: CallerIdentity,
): Promise<Model<Api> | undefined> {
	try {
		return await resolver(modelId, caller);
	} catch (cause) {
		throw new ModelResolverUnavailableError({ cause });
	}
}

export interface FailoverContext {
	/** The inbound request, as an opaque token; the fork reads no identity from it. */
	readonly req: Request;
	/** `candidateKey` of every candidate tried or skipped so far, including the current one. */
	readonly tried: ReadonlySet<string>;
	/** Aborted once the gateway stops waiting for `next`: request abort, deadline, or request end. */
	readonly signal?: AbortSignal;
}

export interface CandidateFailoverOptions {
	/** The candidate after `ctx.tried`, without side effects; `undefined` if none. A rejection means none. */
	next(modelId: string, ctx: FailoverContext): Promise<Model<Api> | undefined>;
	/**
	 * Called once per failed attempt that the classifier marks eligible for failover, and for setup
	 * failures. Never for a skipped candidate, an abort, or a terminal stop such as a 400. Must not throw.
	 */
	onFailure(model: Model<Api>, failure: UpstreamFailure, ctx: FailoverContext): void;
	/**
	 * Request deadline in ms from request start; default 120_000. On expiry no
	 * attempt starts and a running credential setup is aborted (502 or SSE error),
	 * with or without a follower. A started stream is never cut by it.
	 */
	deadlineMs?: number;
}

export type GatewayUsageOutcome = "ok" | "error" | "aborted";

/** One settled upstream call, reported to {@link AuthGatewayRouteOptions.onUsage}. */
export interface GatewayUsageEvent {
	/**
	 * The `x-request-id` of a successful response (error envelopes omit the header).
	 * Video reuses its stable job id on every completed poll; dedupe on this id.
	 */
	requestId: string;
	provider: string;
	model: string;
	usage: Usage;
	outcome: GatewayUsageOutcome;
	at: number;
	client: ClientUsageIdentity;
	/** Identity of the credential that served the call, when the route knows it. */
	account?: string;
	/** Stored row of the credential that served the call, when known exactly. */
	credentialId?: number;
}

/** Map an assistant stop reason to the usage outcome. */
export function gatewayUsageOutcome(stopReason: string): GatewayUsageOutcome {
	return stopReason === "error" || stopReason === "aborted" ? stopReason : "ok";
}

/** What the gateway's routes need, whatever transport carries the requests. */
export interface AuthGatewayRouteOptions {
	/** Source of credentials: broker-backed for `serve`, the CLI's own for `stdio`. */
	storage: AuthStorage;
	/** Try an account-local recovery before recording a usage-limit block. */
	onUsageLimit?: (ctx: {
		provider: string;
		credentialId: number;
		modelId: string;
		signal: AbortSignal;
	}) => Promise<boolean>;
	/** May repeat for the same requestId (video polls); dedupe on it. */
	onUsage?: (event: GatewayUsageEvent) => void | Promise<void>;
	/**
	 * The admitted caller's credential pool. When set it replaces `storage` for
	 * every request, so one tenant's requests never select another's credential.
	 * Key on `ownerUserId` when set, else `agentAccountId`, and return the same
	 * instance for that key on every call (stickiness, backoff and the usage cache
	 * live on it); the embedder owns and closes it. A throw answers 503.
	 */
	resolveStorage?: (caller: AgentCaller) => AuthStorage | Promise<AuthStorage>;
	/** Wraps each routed request, including its `resolveStorage` call. */
	routeScope?: (req: Request, run: () => Promise<Response>) => Promise<Response>;
	/**
	 * Resolve the requested model id with the admitted caller to a pi-ai Model.
	 * May return synchronously or asynchronously; the gateway awaits either form.
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
	/** Providers the host does not serve; `/v1/usage` and `/v1/credentials/check` leave their accounts out. */
	excludeProviders?: ReadonlySet<string>;
	/** Optional stable-name rows, projected independently from provider-qualified model rows. */
	listAliases?: () => Iterable<{ id: string; model: Model<Api> }>;
	/** Upstream transport for every provider call; defaults to global `fetch`. Test seam. */
	fetch?: FetchImpl;
	/** Chat routes retry an eligible pre-output failure on the next candidate, if any; unset keeps one attempt. */
	candidateFailover?: CandidateFailoverOptions;
	/**
	 * Exact Anthropic model id → documented rate-limit table row (e.g. `opus-5.5`).
	 * API-key responses for listed models report their rate-limit headers; at most three rows.
	 */
	apiKeyLimitModelClasses?: Readonly<Record<string, string>>;
}

/** The HTTP server's options: the routes' plus its listener and inbound auth. */
export interface AuthGatewayBootOptions extends AuthGatewayServerOptions, AuthGatewayRouteOptions {}

/**
 * The client's own session key, or `undefined` when it sent none. A blank key
 * counts as none: honouring it would collapse every caller that sends an empty
 * key into one shared credential-sticky, prefix-cache and provider-session
 * bucket.
 */
export function normalizeClientSessionKey(clientKey: string | undefined): string | undefined {
	return clientKey !== undefined && clientKey.trim().length > 0 ? clientKey : undefined;
}

/**
 * Stable identity of the account a request's credential belongs to.
 *
 * `markUsageLimitReached` and the auth-retry resolver switch a session to a
 * sibling credential, so the provider state retained for that session can
 * outlive the account that taught it. OAuth rows expose an account id / email
 * that survives token refresh — fingerprinting the bearer instead would look
 * like a rotation every time a token refreshes and discard the retained
 * lessons for nothing. Key-based rows fall back to a hash of the key, never
 * the key itself: this value is held for the lifetime of the entry.
 */
export function resolveGatewayAccount(
	storage: AuthStorage,
	provider: string,
	sessionId: string,
	apiKey: string,
): string {
	const identity = storage.oauth.identity(provider, sessionId);
	if (identity) {
		return `oauth:${JSON.stringify([
			identity.accountId ?? "",
			identity.email ?? "",
			identity.projectId ?? "",
			identity.orgId ?? "",
		])}`;
	}
	return `key:${Bun.hash(apiKey).toString(36)}`;
}

/** A credential setup failure, tagged so a caller can tell a missing credential from a broken store. */
export interface GatewaySetupFailure extends GatewayErrorClassification {
	readonly setupReason: "no_credential" | "store_error";
}

/**
 * Resolve the credential for one request from broker-backed storage.
 *
 * pi-ai clients never consult `AuthStorage`; the gateway resolves the bearer
 * and its OAuth identity together (refreshing through the broker when needed).
 * Keep this selection snapshot intact even if another request replaces the
 * stored token before dispatch. Storage failures map through
 * {@link classifyGatewayError}; a provider without any credential is a 401.
 */
export async function resolveGatewayApiKey(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	peer: string,
): Promise<ResolvedApiKey | GatewaySetupFailure> {
	let apiKey: ResolvedApiKey | undefined;
	try {
		apiKey = await storage.keys.getWithCredential(model.provider, sessionId, modelKeyOptions(model, signal));
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return { ...classified, setupReason: "store_error" };
	}
	if (apiKey) return apiKey;
	return {
		status: 401,
		type: "authentication_error",
		message: `No credential available for provider ${model.provider}`,
		setupReason: "no_credential",
	};
}

/**
 * Hook fired by a pi-ai client when the upstream request fails in a way
 * that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.limits.markReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.limits.invalidateMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getWithCredential` result (sticky on the
 * same `sessionId`) so the client can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	provider: string,
	oldKey: string,
	credentialId: number | undefined,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
	onUsageLimit?: AuthGatewayRouteOptions["onUsageLimit"],
): Promise<ResolvedApiKey | undefined> {
	const message = error instanceof Error ? error.message : String(error);
	const status = extractHttpStatusFromError(error);
	if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
		if (credentialId !== undefined && onUsageLimit) {
			try {
				if (await onUsageLimit({ provider, credentialId, modelId: model.id, signal })) {
					const restored = await storage.keys.getWithCredential(
						provider,
						sessionId,
						modelKeyOptions(model, signal),
					);
					if (!restored) return undefined;
					const retry = markAfterSiblingWait(restored);
					if (typeof retry === "string") return { apiKey: retry, afterSiblingWait: true };
					return retry ?? undefined;
				}
			} catch (error) {
				logger.warn("auth-gateway usage-limit recovery failed", {
					format,
					provider,
					peer,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const hintMs = extractProviderRetryHint(provider, message);
		// A drained prepaid balance has no reset; don't re-probe the paid key every minute.
		const retryAfterMs =
			hintMs ??
			(isAnthropicCreditBalanceTooLow(message) ? calculateRateLimitBackoffMs("QUOTA_EXHAUSTED") : undefined);
		const { switched, retryAtMs } = await storage.limits.markReached(provider, sessionId, {
			retryAfterMs,
			providerTimed: hintMs !== undefined,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format,
			provider,
			peer,
			switched,
			retryAfterMs,
			retryAtMs,
			error: message,
		});
		if (!switched) return undefined;
		return storage.keys.getWithCredential(provider, sessionId, modelKeyOptions(model, signal));
	}
	await storage.limits.invalidateMatching(provider, oldKey, { sessionId, signal });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: message,
	});
	return storage.keys.getWithCredential(provider, sessionId, modelKeyOptions(model, signal));
}

/** Model-scoped key options: usage ranking by model id, routing to accounts discovery saw serve it. */
function modelKeyOptions(model: Model<Api>, signal: AbortSignal): AuthApiKeyOptions {
	return { modelId: model.id, accountIds: model.accountAccess && Object.keys(model.accountAccess), signal };
}

/**
 * Build the {@link ApiKeyResolver} handed to a pi-ai client for a gateway
 * request. Drives the central a/b/c auth-retry policy server-side:
 *
 * - initial resolve → the credential already resolved for this request.
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → {@link refreshGatewayApiKeyAfterAuthError} switches
 *   to a sibling (usage-limit block vs credential invalidation by error class).
 *
 * `lastKey` tracks the most recent bearer so the switch step invalidates the
 * credential that actually failed; a retry context's `previousKey` wins, since
 * concurrent operations sharing one resolver (split judgment chunks) each know
 * the bearer they sent. `onResolvedKey` observes every rotation so the route
 * can re-key its account lease or usage attribution. `onAttemptFailed` observes
 * every retry step with the row of the bearer whose attempt just failed; one
 * failure can drive two steps (refresh, then rotate), so callers dedupe on the error.
 */
export function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initialKey: ResolvedApiKey,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
	onResolvedKey?: (apiKey: string, credentialId: number | undefined) => void,
	onUsageLimit?: AuthGatewayRouteOptions["onUsageLimit"],
	onAttemptFailed?: (credentialId: number | undefined, error: unknown) => void,
): ApiKeyResolver {
	let lastKey = initialKey.apiKey;
	const credentialIdsByBearer = new Map<string, number | undefined>([[initialKey.apiKey, initialKey.credentialId]]);
	return async ({ lastChance, error, signal, previousKey }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initialKey.apiKey;
			return initialKey;
		}
		onAttemptFailed?.(credentialIdsByBearer.get(previousKey ?? lastKey), error);
		if (!lastChance) {
			const refreshed = await storage.keys.getWithCredential(model.provider, sessionId, {
				...modelKeyOptions(model, sig),
				forceRefresh: true,
				refreshReason: AIError.status(error) === 401 ? "auth-recovery" : undefined,
			});
			lastKey = refreshed?.apiKey ?? lastKey;
			if (refreshed) {
				credentialIdsByBearer.set(refreshed.apiKey, refreshed.credentialId);
				onResolvedKey?.(refreshed.apiKey, refreshed.credentialId);
			}
			return refreshed;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			storage,
			model,
			sessionId,
			model.provider,
			previousKey ?? lastKey,
			credentialIdsByBearer.get(previousKey ?? lastKey),
			error,
			sig,
			format,
			peer,
			onUsageLimit,
		);
		lastKey = next?.apiKey ?? lastKey;
		if (next) {
			credentialIdsByBearer.set(next.apiKey, next.credentialId);
			onResolvedKey?.(next.apiKey, next.credentialId);
		}
		return next;
	};
}

/** Whether settled usage has any billable tokens or reported total cost. */
export function hasGatewayUsage(usage: Usage): boolean {
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		usage.totalTokens > 0 ||
		usage.cost.total > 0
	);
}

/** Reject a model-class map naming more distinct rate-limit rows than the series budget allows. */
export function assertApiKeyLimitModelClasses(classes: Readonly<Record<string, string>> | undefined): void {
	const rows = new Set(Object.values(classes ?? {}));
	if (rows.size > 3) {
		throw new Error(`apiKeyLimitModelClasses names ${rows.size} distinct rows; at most 3 are allowed`);
	}
}

/** Whether a stored row is a paid Anthropic Console key (setup tokens stored as keys are OAuth). */
function isConsoleApiKeyRow(storage: AuthStorage, provider: string, credentialId: number): boolean {
	const credential = storage.credentials.list(provider).find(row => row.id === credentialId)?.credential;
	return credential?.type === "api_key" && !isAnthropicOAuthToken(credential.key);
}

/**
 * `onResponse` for one attempt's stream options: reports a mapped Anthropic
 * model's API-key rate-limit headers against the row bound to the response.
 * `undefined` when the model is not mapped, so unmapped models report nothing.
 */
export function gatewayApiKeyLimitObserver(
	bootOpts: AuthGatewayRouteOptions,
	model: Model<Api>,
): StreamOptions["onResponse"] {
	const classes = bootOpts.apiKeyLimitModelClasses;
	const modelClass =
		model.provider === "anthropic" && classes && Object.hasOwn(classes, model.id) ? classes[model.id] : undefined;
	if (!modelClass) return undefined;
	return response => {
		const credentialId = response.credentialId;
		if (credentialId === undefined || !isConsoleApiKeyRow(bootOpts.storage, model.provider, credentialId)) return;
		const limits = parseAnthropicApiKeyRateLimitHeaders(response.headers, modelClass);
		if (limits.length === 0) return;
		bootOpts.storage.usage.observeLimits([
			{ at: Date.now(), provider: model.provider, credentialId, modelClass, limits },
		]);
	};
}

/**
 * Attribute one settled upstream request to the originating client via the
 * broker's observed-usage channel (`AuthStorage.usage.observe`, batched
 * by the remote store). Error/aborted turns still record — the provider
 * billed whatever tokens the partial turn consumed. A zero-usage result
 * counts only as an attempt outcome for its known credential row; without
 * one (e.g. a failure before credential selection) it is skipped. `at`
 * defaults to now.
 */
export function recordGatewayUsage(
	bootOpts: AuthGatewayRouteOptions,
	model: Model<Api>,
	client: ClientUsageIdentity,
	usage: Usage,
	options: { requestId: string; outcome: GatewayUsageOutcome; at?: number; account?: string; credentialId?: number },
): void {
	const at = options.at ?? Date.now();
	const credentialId = options.credentialId;
	if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 || usage.cost.total > 0) {
		bootOpts.storage.usage.observe({
			provider: model.provider,
			model: model.id,
			at,
			usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
			costUsd: usage.cost.total,
			client,
			...(credentialId !== undefined && { credentialId }),
			outcome: options.outcome,
		});
	} else if (credentialId !== undefined) {
		bootOpts.storage.usage.observeOutcome(
			{ at, provider: model.provider, model: model.id, credentialId, outcome: options.outcome, requests: 1 },
			client,
		);
	}
	if (!hasGatewayUsage(usage)) return;
	emitGatewayUsage(bootOpts, {
		requestId: options.requestId,
		provider: model.provider,
		model: model.id,
		usage,
		outcome: options.outcome,
		at,
		client,
		...(options.account !== undefined && { account: options.account }),
		...(credentialId !== undefined && { credentialId }),
	});
}

/**
 * The `onDroppedAttempt` hook for one gateway request: records every settled attempt the
 * stream's result does not carry (abandoned for a rotation, or ended by a thrown error)
 * against its own credential row. Each gets a distinct `requestId` so `onUsage` consumers
 * never fold it into the answer. No `account` label: the request's account tracker has
 * already moved to the rotated key when the hook fires, and the row id is exact.
 */
export function gatewayDroppedAttemptRecorder(
	bootOpts: AuthGatewayRouteOptions,
	model: Model<Api>,
	client: ClientUsageIdentity,
	requestId: string,
): NonNullable<StreamOptions["onDroppedAttempt"]> {
	let dropped = 0;
	return attempt => {
		dropped++;
		observeAttemptLimitStatus(bootOpts.storage, model.provider, attempt.credentialId, attempt.error);
		recordGatewayUsage(bootOpts, model, client, attempt.usage, {
			requestId: `${requestId}:d${dropped}`,
			outcome: attempt.outcome,
			credentialId: attempt.credentialId,
		});
	};
}

/**
 * Record the throttle or credit-depletion status of one failed attempt on the row that
 * served it. Other quota and billing classes record none.
 */
export function observeAttemptLimitStatus(
	storage: AuthStorage,
	provider: string,
	credentialId: number | undefined,
	failure: unknown,
): void {
	if (credentialId === undefined || failure === undefined) return;
	const isMessage = typeof failure === "object" && failure !== null && "stopReason" in failure;
	const status = isMessage ? (failure as AssistantMessage).errorStatus : extractHttpStatusFromError(failure);
	const message = isMessage
		? ((failure as AssistantMessage).errorClassificationMessage ?? (failure as AssistantMessage).errorMessage ?? "")
		: failure instanceof Error
			? failure.message
			: String(failure);
	const error = observedLimitErrorStatus(status, message);
	if (error) storage.usage.observeLimits([{ at: Date.now(), provider, credentialId, limits: [], error }]);
}

/**
 * Records every thinking-loop result a unary completion re-sampled past. The returned
 * `onAttempt` holds each result until the next arrives, so the final one (recorded by the
 * route) is never counted twice; `settle` records a held result the route never received.
 */
export function gatewayThinkingLoopRecorder(
	bootOpts: AuthGatewayRouteOptions,
	model: Model<Api>,
	client: ClientUsageIdentity,
	requestId: string,
): { onAttempt: (message: AssistantMessage) => void; settle: (final: AssistantMessage | undefined) => void } {
	let held: AssistantMessage | undefined;
	let recorded = 0;
	const record = (message: AssistantMessage): void => {
		recorded++;
		observeAttemptLimitStatus(bootOpts.storage, model.provider, message.credentialId, message);
		recordGatewayUsage(bootOpts, model, client, message.usage, {
			requestId: `${requestId}:t${recorded}`,
			outcome: gatewayUsageOutcome(message.stopReason),
			at: message.timestamp || undefined,
			credentialId: message.credentialId,
		});
	};
	return {
		onAttempt: message => {
			if (held) record(held);
			held = message;
		},
		settle: final => {
			if (held && held !== final) record(held);
			held = undefined;
		},
	};
}

/**
 * Per-request outcome recorder for the non-chat routes (embeddings, images,
 * rerank, speech, transcriptions). Their providers retry through `withAuth`, so
 * the route sees only the final result: `onAttemptFailed` (pass it to
 * {@link buildGatewayApiKeyResolver}) records each abandoned attempt against the
 * row that served it, once per error, and `recordFinal` records the request's
 * terminal failure unless that same error was already recorded as abandoned.
 * Failures carry no usage, so they count only as attempt outcomes.
 */
export function gatewayAttemptOutcomes(
	bootOpts: AuthGatewayRouteOptions,
	model: Model<Api>,
	client: ClientUsageIdentity,
	requestId: string,
): {
	onAttemptFailed: (credentialId: number | undefined, error: unknown) => void;
	recordFinal: (credentialId: number | undefined, error: unknown, outcome: "error" | "aborted") => void;
} {
	let recordedError: unknown;
	let recorded = 0;
	const record = (credentialId: number | undefined, error: unknown, outcome: "error" | "aborted"): void => {
		if (recorded > 0 && error === recordedError) return;
		recordedError = error;
		recorded++;
		observeAttemptLimitStatus(bootOpts.storage, model.provider, credentialId, error);
		recordGatewayUsage(bootOpts, model, client, emptyUsage(), {
			requestId: `${requestId}:d${recorded}`,
			outcome,
			credentialId,
		});
	};
	return {
		onAttemptFailed: (credentialId, error) => record(credentialId, error, "error"),
		recordFinal: record,
	};
}

/** Call the boot hook; synchronous throws and asynchronous rejections are logged. */
export function emitGatewayUsage(bootOpts: AuthGatewayRouteOptions, event: GatewayUsageEvent): void {
	try {
		const result = bootOpts.onUsage?.({ ...event, usage: structuredClone(event.usage), client: { ...event.client } });
		if (result && typeof result.then === "function") {
			void result.catch(error => logger.warn("auth-gateway onUsage hook failed", { error }));
		}
	} catch (error) {
		logger.warn("auth-gateway onUsage hook failed", { error });
	}
}

/**
 * An `AbortController` that follows the inbound request's abort signal. Routes
 * abort it themselves when the response body is cancelled mid-stream, which
 * `req.signal` alone does not observe.
 */
export function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}
