import { logger } from "@oh-my-pi/pi-utils";
import type { ProviderResponseMetadata } from "../types";
import { parseAnthropicApiKeyRateLimitHeaders } from "../usage/anthropic-api";
import { parseClaudeRateLimitHeaders } from "../usage/claude";
import { parseCodexRateLimitHeaders } from "../usage/openai-codex";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "../utils/retry-after";
import type { CallerIdentity } from "./types";

export interface GatewayLogContext {
	requestId: string;
	pool: string;
	format: string;
	provider: string;
	model: string;
}

type Fields = Record<string, string | number>;

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function httpStatus(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

// Always construct a new object before invoking logger: sinks receive the original context.
function fields(context: GatewayLogContext, credentialId?: number, status?: number): Fields {
	const result: Fields = {};
	for (const key of ["requestId", "pool", "format", "provider", "model"] as const) {
		if (typeof context[key] === "string") result[key] = context[key];
	}
	if (nonnegative(credentialId) && Number.isInteger(credentialId)) result.credentialId = credentialId;
	if (httpStatus(status)) result.status = status;
	return result;
}

export function gatewayLogContext(
	requestId: string,
	caller: CallerIdentity,
	format: string,
	provider: string,
	model: string,
): GatewayLogContext {
	return {
		requestId,
		pool: caller.kind === "agent" ? (caller.ownerUserId ?? caller.agentAccountId) : "enroll",
		format,
		provider,
		model,
	};
}

export function logGatewaySelection(context: GatewayLogContext, credentialId?: number): void {
	logger.info("auth-gateway credential selected", fields(context, credentialId));
}

export function logGatewayRecoveryFailure(context: GatewayLogContext, credentialId?: number): void {
	logger.warn("auth-gateway usage-limit recovery failed", fields(context, credentialId));
}

export function logGatewayRequestFailure(context: GatewayLogContext, status?: number, credentialId?: number): void {
	logger.warn("auth-gateway request failed", fields(context, credentialId, status));
}

function numberHeader(headers: Record<string, string>, name: string): number | undefined {
	const value = headers[name];
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return nonnegative(parsed) ? parsed : undefined;
}

function normalizedHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") result[key.toLowerCase()] = value;
	}
	return result;
}

function observedRetryAfterMs(headers: Record<string, string>): number | undefined {
	const parsed = getRetryAfterMsFromHeaders(headers);
	if (nonnegative(parsed)) return parsed;
	if (numberHeader(headers, "retry-after-ms") === 0 || numberHeader(headers, "retry-after") === 0) return 0;
	return undefined;
}

function quota(
	context: GatewayLogContext,
	response: ProviderResponseMetadata,
	window: string,
	values: { durationMs?: number; resetAtMs?: number; usedPercent?: number; limit?: number; remaining?: number },
): void {
	const result = fields(context, response.credentialId, response.status);
	result.window = window;
	let observed = false;
	for (const key of ["durationMs", "resetAtMs", "usedPercent", "limit", "remaining"] as const) {
		const value = values[key];
		if (!nonnegative(value)) continue;
		if ((key === "durationMs" || key === "resetAtMs") && value === 0) continue;
		if (key === "usedPercent" && value > 100) continue;
		result[key] = value;
		observed = true;
	}
	if (observed) logger.info("auth-gateway quota observation", result);
}

export function logGatewayProviderResponse(
	context: GatewayLogContext,
	response: ProviderResponseMetadata,
	apiKeyModelClass?: string,
): void {
	if (!httpStatus(response.status)) return;
	const headers = normalizedHeaders(response.headers);
	const result = fields(context, response.credentialId, response.status);
	const retryAfterMs = observedRetryAfterMs(headers);
	if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
	logger.info("auth-gateway provider response", result);
	if (context.provider === "openai-codex") {
		// Reuse the provider parser, but reject malformed/out-of-domain observations before its clamping.
		for (const window of ["primary", "secondary"] as const) {
			const prefix = `x-codex-${window}-`;
			const used = numberHeader(headers, `${prefix}used-percent`);
			const safe: Record<string, string> = {};
			if (used !== undefined && used <= 100) safe[`${prefix}used-percent`] = String(used);
			for (const suffix of ["window-minutes", "reset-at"]) {
				const value = numberHeader(headers, `${prefix}${suffix}`);
				if (value !== undefined && value > 0) safe[`${prefix}${suffix}`] = String(value);
			}
			const limit = parseCodexRateLimitHeaders(safe)?.limits[0];
			const minutes = numberHeader(safe, `${prefix}window-minutes`);
			const reset = numberHeader(safe, `${prefix}reset-at`);
			quota(context, response, window, {
				durationMs: limit?.window?.durationMs ?? (minutes !== undefined ? minutes * 60_000 : undefined),
				resetAtMs: limit?.window?.resetsAt ?? (reset !== undefined ? reset * (reset > 1e12 ? 1 : 1000) : undefined),
				usedPercent: limit?.amount.used,
			});
		}
		return;
	}
	if (context.provider !== "anthropic") return;
	for (const window of ["5h", "7d", "7d_oi"] as const) {
		const prefix = `anthropic-ratelimit-unified-${window}-`;
		const utilization = numberHeader(headers, `${prefix}utilization`);
		const safe: Record<string, string> = {};
		if (utilization !== undefined && utilization <= 1) safe[`${prefix}utilization`] = String(utilization);
		const reset = numberHeader(headers, `${prefix}reset`);
		if (reset !== undefined && reset > 0) safe[`${prefix}reset`] = String(reset);
		const limit = parseClaudeRateLimitHeaders(safe)?.limits[0];
		if (safe[`${prefix}utilization`] !== undefined)
			quota(context, response, window, {
				durationMs: limit?.window?.durationMs,
				resetAtMs: limit?.window?.resetsAt,
				usedPercent: limit?.amount.used,
			});
		else if (reset !== undefined && reset > 0) quota(context, response, window, { resetAtMs: reset * 1000 });
	}
	logGatewayApiKeyQuota(context, response, apiKeyModelClass);
}

export function logGatewayApiKeyQuota(
	context: GatewayLogContext,
	response: ProviderResponseMetadata,
	modelClass?: string,
): void {
	if (!httpStatus(response.status) || context.provider !== "anthropic") return;
	const headers = normalizedHeaders(response.headers);
	const safe: Record<string, string> = {};
	for (const window of ["requests", "input-tokens", "output-tokens"] as const) {
		const prefix = `anthropic-ratelimit-${window}-`;
		for (const counter of ["limit", "remaining"] as const) {
			const value = numberHeader(headers, `${prefix}${counter}`);
			if (value !== undefined) safe[`${prefix}${counter}`] = String(value);
		}
		const reset = headers[`${prefix}reset`];
		if (typeof reset === "string" && reset.trim() !== "") safe[`${prefix}reset`] = reset;
	}
	// No configured API-key row means no API-key window attribution.
	for (const limit of parseAnthropicApiKeyRateLimitHeaders(safe, modelClass)) {
		const window = limit.window?.id;
		if (window !== "requests" && window !== "input-tokens" && window !== "output-tokens") continue;
		quota(context, response, window, {
			resetAtMs: limit.window?.resetsAt,
			limit: limit.amount.limit,
			remaining: limit.amount.remaining,
		});
	}
}

export function logGatewayAttemptFailure(
	context: GatewayLogContext,
	credentialId: number | undefined,
	error: unknown,
	stage: "refresh" | "rotation" | "terminal",
): void {
	const status =
		typeof error === "object" && error !== null && "status" in error && httpStatus(error.status)
			? error.status
			: undefined;
	const result = fields(context, credentialId, status);
	result.stage = stage;
	const source = getHeadersFromError(error);
	if (source) {
		const headers: Record<string, string> = {};
		if (source instanceof Headers)
			source.forEach((value, key) => {
				headers[key] = value;
			});
		else
			for (const [key, value] of Object.entries(source))
				if (typeof value === "string") headers[key.toLowerCase()] = value;
		const retryAfterMs = observedRetryAfterMs(headers);
		if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
	}
	logger.warn("auth-gateway provider attempt failed", result);
}
