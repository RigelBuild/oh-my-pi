import { isRecord } from "@oh-my-pi/pi-utils";
import { isUsageLimit, status as getErrorStatus } from "./flags";
import { isBillingCapAnswer, isConcurrencyCapExclusion, isUsageLimitOutcome, parseRateLimitReason } from "./rate-limit";
import { isProviderRetryableError } from "./retryable";
import type { Api, Model } from "../types";
import { extractProviderRetryHint, getHeadersFromError, getRetryAfterMsFromHeaders } from "../utils/retry-after";

/** A gateway-facing classification of an arbitrary upstream/internal error. */
export interface GatewayErrorClassification {
	status: number;
	type: string;
	message: string;
}

/**
 * Classify an upstream / gateway-internal error into a status code and a
 * format-neutral type. The order is intentional:
 *
 *  1. Honour a numeric HTTP status the error carries as a structured field:
 *     `status`, `statusCode` or `response.status`, or the same on its `cause`.
 *     The message text is never read in this step.
 *  2. A billing cap keeps its upstream status. An answered upstream message
 *     passes its `errorStatus` as `upstreamStatus`. A 402, or billing wording
 *     ({@link isBillingCapAnswer}), keeps that status: topping up clears it,
 *     so a 429 would only invite a retry.
 *  3. Parse a status code embedded in the message string. Provider errors
 *     virtually always carry one (`Google API error (400): …`, `HTTP 429`,
 *     `status=503`) and the embedded value is authoritative.
 *  4. Fall through to **word-boundaried** substring heuristics. The old
 *     `lower.includes("rate")` test famously matched `GenerateContentRequest`,
 *     surfacing every Google 400 as a 429 `rate_limit_error`. The patterns here
 *     all require boundaries so they don't collide with provider field names.
 */
export function classifyGatewayError(err: unknown, upstreamStatus?: number): GatewayErrorClassification {
	const message = err instanceof Error ? err.message : String(err);

	// 1. A numeric HTTP status the error carries as a structured field, never one parsed from its message.
	const httpStatus = ownHttpStatus(err) ?? (isRecord(err) ? ownHttpStatus(err.cause) : undefined);
	if (httpStatus !== undefined) return bucketStatus(httpStatus, message);

	if (err instanceof Error && err.name === "AbortError") return { status: 499, type: "request_aborted", message };
	// 2. A billing cap keeps the status it arrived with: topping up clears it, so a 429 would only invite a retry.
	if (upstreamStatus !== undefined && (upstreamStatus === 402 || isBillingCapAnswer(upstreamStatus, message))) {
		return bucketStatus(upstreamStatus, message);
	}

	// 3. Status code embedded in the message. Requires a contextual keyword
	// (`HTTP`, `API error`, `status`, …) or a leading `(NNN)` token so we
	// don't trip on incidental three-digit numbers ("took 200ms").
	const embedded = extractEmbeddedStatus(message);
	if (embedded !== undefined) return bucketStatus(embedded, message);

	// 4. Word-boundaried substring heuristics.
	if (/\baborted\b|\babort signal\b/i.test(message)) {
		return { status: 499, type: "request_aborted", message };
	}
	if (
		// Match rate-limit phrasings before auth wording: some providers
		// describe throttling as "unauthorized due to rate limit".
		// Keep boundaries so this does not collide with
		// `GenerateContentRequest`, `accelerate`, `iterate`, `deprecated`, etc.
		/\brate[- _]?limit(?:s|ed|ing)?\b|\bquota(?:_exceeded| exceeded)?\b|\btoo[- _]many[- _]requests\b/i.test(
			message,
		) ||
		// Usage-limit phrasings emit no embedded status. Codex friendly text
		// reads "You have hit your ChatGPT usage limit … Try again in ~158
		// min."; the central usage-limit classifier already encodes every known
		// provider variant, so reuse it instead of forking the regex. Without
		// this branch the classifier falls through to the default
		// 502/upstream_error, which is what callers saw when their account
		// hit its cap.
		isUsageLimit(message)
	) {
		return { status: 429, type: "rate_limit_error", message };
	}
	if (/\b(?:unauthorized|forbidden)\b/i.test(message)) {
		return { status: 401, type: "authentication_error", message };
	}
	if (/\b(?:unsupported|invalid_request|invalid request|bad request|malformed)\b/i.test(message)) {
		return { status: 400, type: "invalid_request_error", message };
	}
	return { status: 502, type: "upstream_error", message };
}

function bucketStatus(status: number, message: string): GatewayErrorClassification {
	if (status === 401 || status === 403) return { status, type: "authentication_error", message };
	if (status === 429) return { status, type: "rate_limit_error", message };
	if (status >= 400 && status < 500) return { status, type: "invalid_request_error", message };
	if (status >= 500) return { status, type: "upstream_error", message };
	return { status: 502, type: "upstream_error", message };
}

/**
 * Pull a status code from common error-message shapes. Returns undefined when
 * no contextual keyword is present, so we never guess at incidental numbers.
 */
function extractEmbeddedStatus(message: string): number | undefined {
	// `Google API error (400)`, `OpenAI API error (429): …`, `(503)`
	// `HTTP 429: too many requests`
	// `status: 503`, `status_code=429`, `status=400`
	const re = /(?:\bHTTP\b|\bAPI error\b|\bstatus(?:[- _]?code)?\b)\s*[:=]?\s*\(?\s*(\d{3})\b|\((\d{3})\)/i;
	const m = message.match(re);
	if (!m) return undefined;
	const raw = m[1] ?? m[2];
	if (!raw) return undefined;
	const code = Number.parseInt(raw, 10);
	return Number.isFinite(code) && code >= 100 && code < 600 ? code : undefined;
}

/**
 * The numeric HTTP status a thrown value carries in its own `status`,
 * `statusCode` or `response.status` field. Message text is never parsed here:
 * step 3 ({@link extractEmbeddedStatus}) owns that.
 */
function ownHttpStatus(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const response = isRecord(value.response) ? value.response.status : undefined;
	for (const candidate of [value.status, value.statusCode, response]) {
		if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
			return candidate;
		}
	}
	return undefined;
}

export type UpstreamFailureKind =
	| "transport"
	| "server_error"
	| "rate_limited"
	| "credential_exhausted"
	| "not_served"
	| "setup_error";

export interface UpstreamFailure {
	readonly kind: UpstreamFailureKind;
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly message: string;
}

/** Non-abort failures only. `undefined` means stop. `message` is `errorClassificationMessage ?? errorMessage`. */
export function classifyUpstreamFailure(
	model: Model<Api>,
	error: unknown,
	status: number | undefined,
	message: string | undefined,
): UpstreamFailure | undefined {
	const errorMessage = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
	const text = message ?? errorMessage ?? "";
	const errorStatus = status ?? getErrorStatus(error);
	const classificationError = error instanceof Error ? new Error(text, { cause: error }) : new Error(text);
	if (errorStatus !== undefined) Object.assign(classificationError, { status: errorStatus });
	let kind: UpstreamFailureKind;
	if (isUsageLimit(classificationError) || isUsageLimitOutcome(errorStatus, text)) {
		kind = "credential_exhausted";
	} else if (errorStatus === 401 || (errorStatus === 403 && !isConcurrencyCapExclusion(errorStatus, text))) {
		kind = "credential_exhausted";
	} else if ((errorStatus === 403 && isConcurrencyCapExclusion(errorStatus, text)) || errorStatus === 429) {
		kind = "rate_limited";
	} else if (errorStatus === 404) kind = "not_served";
	else if (errorStatus !== undefined) {
		if (errorStatus === 408 || errorStatus >= 500) kind = "server_error";
		else return undefined;
	} else {
		if (!isProviderRetryableError(classificationError)) return undefined;
		const reason = parseRateLimitReason(text);
		if (reason === "RATE_LIMIT_EXCEEDED" || reason === "CONCURRENT_LIMIT") kind = "rate_limited";
		else if (reason === "MODEL_CAPACITY_EXHAUSTED" || reason === "SERVER_ERROR") kind = "server_error";
		else kind = "transport";
	}

	const retryAfterMs =
		error instanceof Error
			? getRetryAfterMsFromHeaders(getHeadersFromError(error))
			: extractProviderRetryHint(model.provider, text);
	return {
		kind,
		...(errorStatus !== undefined && { status: errorStatus }),
		...(retryAfterMs !== undefined && { retryAfterMs }),
		message: text,
	};
}
