/**
 * ArkType schemas for the auth-broker wire protocol.
 *
 * Shared between the server (validates inbound request bodies) and the client
 * (validates responses from the broker). Schemas mirror the TypeScript types
 * in `./types.ts` 1:1; the types remain the source of truth for static typing,
 * and `Type` is asserted-compatible with them where possible.
 *
 * Envelope and fixed-shape schemas use `"+": "reject"` so unknown keys are
 * rejected — the previous implementation used a hand-rolled `hasOnlyFields`
 * allowlist for the same effect. The OAuth credential schema is the deliberate
 * exception (standard type keeps extra keys): it preserves provider-specific extension fields so
 * they round-trip through the broker instead of being dropped (see below).
 */
import { type FluentType, type } from "@oh-my-pi/omptype";
import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	type DisabledCredentialSummary,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type RemoteOAuthCredential,
	type SnapshotCredential,
} from "../auth-storage";
import type {
	ClientUsageReportRequest,
	ClientUsageReportResponse,
	ClientUsageSummaryResponse,
	CredentialBlockDeleteRequest,
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlockSnapshot,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	DisabledCredentialsResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
	UsageHistoryResponse,
	UsageResponse,
	UsageStaleResponse,
} from "./types";
import { MAX_OBSERVED_LIMIT_OBSERVATIONS, MAX_OBSERVED_OUTCOMES, MAX_OBSERVED_USAGE_ENTRIES } from "./types";

// ─── Credential payloads ─────────────────────────────────────────────────────

/** Real OAuth credential (broker-side) — refresh token is the actual upstream value. */
export const oauthCredentialSchema: FluentType<OAuthCredential> = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type("string").narrow(
		(value, ctx) =>
			value !== REMOTE_REFRESH_SENTINEL ||
			ctx.mustBe(`not equal to the remote sentinel (${REMOTE_REFRESH_SENTINEL})`),
	),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAt?": "number",
});

/** OAuth credential as it appears in broker snapshots — refresh replaced with sentinel. */
export const remoteOauthCredentialSchema: FluentType<RemoteOAuthCredential> = type({
	"apiEndpoint?": "string",
	type: "'oauth'",
	refresh: type.enumerated(REMOTE_REFRESH_SENTINEL),
	access: type("string").atLeastLength(1),
	expires: "number",
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAt?": "number",
});

export const apiKeyCredentialSchema: FluentType<ApiKeyCredential> = type({
	"+": "reject",
	type: "'api_key'",
	key: type("string").atLeastLength(1),
	"source?": "'login'",
});

/** Discriminated union accepted on POST /v1/credential (writes). */
export const writableAuthCredentialSchema: FluentType<AuthCredential> =
	oauthCredentialSchema.or(apiKeyCredentialSchema);

/** Discriminated union returned in snapshots (refresh is sentinel for OAuth). */
export const snapshotCredentialSchema: FluentType<SnapshotCredential> =
	remoteOauthCredentialSchema.or(apiKeyCredentialSchema);

// ─── Snapshot ────────────────────────────────────────────────────────────────

export const credentialSnapshotEntrySchema: FluentType<AuthCredentialSnapshotEntry> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
});

export const credentialBlockSnapshotSchema: FluentType<CredentialBlockSnapshot> = type({
	"+": "reject",
	providerKey: type("string").atLeastLength(1),
	blockScope: "string",
	blockedUntilMs: "number",
	"updatedAtMs?": "number",
});

export const snapshotEntrySchema: FluentType<SnapshotEntry> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	credential: snapshotCredentialSchema,
	identityKey: "string | null",
	rotatesInMs: "number | null",
	"blocks?": credentialBlockSnapshotSchema.array(),
});

export const refresherScheduleSchema: FluentType<RefresherSchedule> = type({
	"+": "reject",
	enabled: "boolean",
	intervalMs: "number",
	skewMs: "number",
	nextSweepInMs: "number",
});

export const snapshotResponseSchema: FluentType<SnapshotResponse> = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
});

// ─── Snapshot stream (SSE) ───────────────────────────────────────────────────

/** First frame on connect — full snapshot embedded inline with a `kind` tag. */
export const snapshotStreamSnapshotEventSchema: FluentType<SnapshotStreamSnapshotEvent> = type({
	"+": "reject",
	generation: "number.integer",
	generatedAt: "number",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	credentials: snapshotEntrySchema.array(),
	kind: "'snapshot'",
});

/** Per-credential upsert/refresh delta. */
export const snapshotStreamEntryEventSchema: FluentType<SnapshotStreamEntryEvent> = type({
	"+": "reject",
	kind: "'entry'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	entry: snapshotEntrySchema,
});

/** Per-credential delete delta. */
export const snapshotStreamRemovedEventSchema: FluentType<SnapshotStreamRemovedEvent> = type({
	"+": "reject",
	kind: "'removed'",
	generation: "number.integer",
	serverNowMs: "number",
	refresher: refresherScheduleSchema,
	id: "number.integer",
});

/** Discriminated union over every event frame the snapshot stream emits. */
export const snapshotStreamEventSchema: FluentType<SnapshotStreamEvent> = snapshotStreamSnapshotEventSchema
	.or(snapshotStreamEntryEventSchema)
	.or(snapshotStreamRemovedEventSchema);

// ─── Healthz ─────────────────────────────────────────────────────────────────

export const healthzResponseSchema: FluentType<HealthzResponse> = type({
	"+": "reject",
	ok: "boolean",
	"version?": "string",
});

// ─── Usage ───────────────────────────────────────────────────────────────────

const usageWindowSchema = type({
	id: "string",
	label: "string",
	"durationMs?": "number",
	"resetsAt?": "number",
});

const usageAmountSchema = type({
	"used?": "number",
	"limit?": "number",
	"remaining?": "number",
	"usedFraction?": "number",
	"remainingFraction?": "number",
	unit: "'percent' | 'tokens' | 'requests' | 'credits' | 'usd' | 'minutes' | 'bytes' | 'unknown'",
});

const usageScopeSchema = type({
	provider: "string",
	"accountId?": "string",
	"projectId?": "string",
	"orgId?": "string",
	"modelId?": "string",
	"tier?": "string",
	"windowId?": "string",
	"shared?": "boolean",
	"sharedGroup?": "string",
});

const usageLimitSchema = type({
	id: "string",
	label: "string",
	scope: usageScopeSchema,
	"window?": usageWindowSchema,
	amount: usageAmountSchema,
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
	"notes?": "string[]",
});

const usageResetCreditsSchema = type({
	availableCount: "number",
	"redeemableCount?": "number",
	"nextCreditId?": "string",
	"eligible?": "boolean",
	"reason?": "string",
	"cooldownUntil?": "string",
	"credits?": type({
		"id?": "string",
		"title?": "string",
		"program?": "string",
		"remainingCount?": "number",
		"usable?": "boolean",
		"requiresLimit?": "boolean",
		"clears?": "string[]",
		"blocking?": "string[]",
		"usedFractions?": { "[string]": "number" },
		"grantedAt?": "string",
		"expiresAt?": "string",
		"status?": "string",
	}).array(),
});

const arkUsageReportSchema = type({
	provider: "string",
	fetchedAt: "number",
	limits: usageLimitSchema.array(),
	"resetCredits?": usageResetCreditsSchema,
	"notes?": "string[]",
	"metadata?": { "[string]": "unknown" },
	"raw?": "unknown",
});

/**
 * Broker `/v1/usage` response. Reports are full {@link UsageReport}s minus the
 * heavy provider-specific `raw` field (the server strips it before send) — we
 * keep `raw` optional in the underlying schema so a misconfigured broker that
 * forgot to strip still validates.
 */
export const usageResponseSchema: FluentType<UsageResponse> = type({
	"+": "reject",
	generatedAt: "number",
	reports: arkUsageReportSchema.array(),
});

const usageHistoryEntrySchema = type({
	recordedAt: "number",
	provider: "string",
	accountKey: "string",
	"email?": "string",
	"accountId?": "string",
	limitId: "string",
	label: "string",
	"windowLabel?": "string",
	"usedFraction?": "number",
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
	"resetsAt?": "number",
});

/** Broker `/v1/usage/history` response — recorded usage-limit snapshots, oldest first. */
export const usageHistoryResponseSchema: FluentType<UsageHistoryResponse> = type({
	"+": "reject",
	generatedAt: "number",
	entries: usageHistoryEntrySchema.array(),
});

const safeEpochMsSchema = type("0 <= number.integer <= 9007199254740991");
const boundedUsageNumberSchema = type("0 <= number <= 1000000000000");
const boundedCostSchema = type("0 <= number <= 1000000000");
const observedUsageOutcomeSchema = type("'ok' | 'error' | 'aborted'");
const credentialIdSchema = type("0 < number.integer <= 9007199254740991");

const observedUsageEntrySchema = type({
	"+": "reject",
	at: safeEpochMsSchema,
	provider: "0 < string <= 128",
	model: "0 < string <= 256",
	requests: boundedUsageNumberSchema,
	inputTokens: boundedUsageNumberSchema,
	outputTokens: boundedUsageNumberSchema,
	cacheReadTokens: boundedUsageNumberSchema,
	cacheWriteTokens: boundedUsageNumberSchema,
	costUsd: boundedCostSchema,
	"credentialId?": credentialIdSchema,
	"outcome?": observedUsageOutcomeSchema,
});

const observedAttemptOutcomeSchema = type({
	"+": "reject",
	at: safeEpochMsSchema,
	provider: "0 < string <= 128",
	model: "0 < string <= 256",
	credentialId: credentialIdSchema,
	outcome: observedUsageOutcomeSchema,
	requests: "0 < number.integer <= 1000000000000",
});

const observedLimitAmountSchema = type({
	"+": "reject",
	"used?": boundedUsageNumberSchema,
	"limit?": boundedUsageNumberSchema,
	"remaining?": boundedUsageNumberSchema,
	"usedFraction?": "0 <= number <= 1",
	"remainingFraction?": "0 <= number <= 1",
	unit: "'percent' | 'tokens' | 'requests' | 'credits' | 'usd' | 'minutes' | 'bytes' | 'unknown'",
});
/** Window ids `parseAnthropicApiKeyRateLimitHeaders` emits; the only limit ids the broker persists. */
const OBSERVED_LIMIT_WINDOWS = ["requests", "input-tokens", "output-tokens"] as const;
/** A configured model-class row label; also the `<row>` segment of `anthropic:api:<row>:<window>`. */
const observedModelClassSchema = type(/^[a-z0-9][a-z0-9._-]{0,31}$/);
const observedLimitWindowSchema = type("'requests' | 'input-tokens' | 'output-tokens'");

/** One parsed API-key window: a closed shape with bounded strings, no free-form notes. */
const observedLimitSchema = type({
	"+": "reject",
	id: "0 < string <= 64",
	label: "0 < string <= 64",
	scope: type({
		"+": "reject",
		provider: "0 < string <= 128",
		"modelId?": observedModelClassSchema,
		"windowId?": observedLimitWindowSchema,
	}),
	"window?": type({
		"+": "reject",
		id: observedLimitWindowSchema,
		label: "0 < string <= 64",
		"durationMs?": "number",
		"resetsAt?": "number",
	}),
	amount: observedLimitAmountSchema,
	"status?": "'ok' | 'warning' | 'exhausted' | 'unknown'",
});

const observedLimitObservationSchema = type({
	"+": "reject",
	at: safeEpochMsSchema,
	provider: "0 < string <= 128",
	credentialId: credentialIdSchema,
	"modelClass?": observedModelClassSchema,
	limits: observedLimitSchema.array().atMostLength(OBSERVED_LIMIT_WINDOWS.length),
	"error?": "'credit_exhausted' | 'rate_limited'",
}).narrow((observation, ctx) => {
	// Every id must be one the parser emits for this row: `anthropic:api:<modelClass>:<window>`.
	const allowed = OBSERVED_LIMIT_WINDOWS.map(window => `anthropic:api:${observation.modelClass}:${window}`);
	for (const limit of observation.limits) {
		if (observation.modelClass === undefined || !allowed.includes(limit.id)) {
			return ctx.mustBe("a limit id of the form anthropic:api:<modelClass>:<requests|input-tokens|output-tokens>");
		}
	}
	return true;
});

/**
 * Broker `POST /v1/usage/observed` request — one client's batched observed usage.
 * `outcomes` and `limits` are optional so pre-identity gateways keep validating;
 * the strict envelope means an old broker rejects them, and the reporter then
 * falls back to the legacy shape.
 */
export const clientUsageReportRequestSchema: FluentType<ClientUsageReportRequest> = type({
	"+": "reject",
	installId: "0 < string <= 256",
	"hostname?": "0 < string <= 128",
	"app?": "0 < string <= 128",
	entries: observedUsageEntrySchema.array().atMostLength(MAX_OBSERVED_USAGE_ENTRIES),
	"outcomes?": observedAttemptOutcomeSchema.array().atMostLength(MAX_OBSERVED_OUTCOMES),
	"limits?": observedLimitObservationSchema.array().atMostLength(MAX_OBSERVED_LIMIT_OBSERVATIONS),
	"batchId?": "string.uuid",
});

export const clientUsageReportResponseSchema: FluentType<ClientUsageReportResponse> = type({
	"+": "reject",
	ok: "boolean",
});

const clientUsageClientSummarySchema = type({
	installId: "string",
	"hostname?": "string",
	firstSeen: "number",
	lastSeen: "number",
	providers: type({
		"app?": "string",
		provider: "string",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		costUsd: "number",
	}).array(),
});

/** Broker `GET /v1/usage/clients` response — per-client token burn aggregates. */
export const clientUsageSummaryResponseSchema: FluentType<ClientUsageSummaryResponse> = type({
	"+": "reject",
	generatedAt: "number",
	clients: clientUsageClientSummarySchema.array(),
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

export const credentialRefreshResponseSchema: FluentType<CredentialRefreshResponse> = type({
	"+": "reject",
	entry: credentialSnapshotEntrySchema,
});

// ─── Disable ─────────────────────────────────────────────────────────────────

export const credentialDisableRequestSchema: FluentType<{ cause?: string }> = type({
	"+": "reject",
	"cause?": "string",
});

export const credentialDisableResponseSchema: FluentType<CredentialDisableResponse> = type({
	"+": "reject",
	ok: "boolean",
});

/** One disabled-credential tombstone — identity + cause, never token material. */
export const disabledCredentialSummarySchema: FluentType<DisabledCredentialSummary> = type({
	"+": "reject",
	id: "number.integer",
	provider: type("string").atLeastLength(1),
	type: "'oauth' | 'api_key'",
	"email?": "string",
	"accountId?": "string",
	"orgId?": "string",
	"orgName?": "string",
	cause: "string",
	"disabledAtMs?": "number",
});

/** Broker `GET /v1/credentials/disabled` response. */
export const disabledCredentialsResponseSchema: FluentType<DisabledCredentialsResponse> = type({
	"+": "reject",
	generatedAt: "number",
	disabled: disabledCredentialSummarySchema.array(),
});

// ─── Credential blocks ───────────────────────────────────────────────────────

export const credentialBlockRequestSchema: FluentType<CredentialBlockRequest> = credentialBlockSnapshotSchema;

export const credentialBlockDeleteRequestSchema: FluentType<CredentialBlockDeleteRequest> = type({
	"+": "reject",
	providerKey: type("string").atLeastLength(1),
	blockScope: "string",
});

export const credentialBlockResponseSchema: FluentType<CredentialBlockResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const credentialBlocksDeleteResponseSchema: FluentType<CredentialBlocksDeleteResponse> = type({
	"+": "reject",
	ok: "boolean",
});

export const usageStaleResponseSchema: FluentType<UsageStaleResponse> = type({
	"+": "reject",
	ok: "boolean",
});

// ─── Upload ──────────────────────────────────────────────────────────────────

export const credentialUploadRequestSchema: FluentType<CredentialUploadRequest> = type({
	"+": "reject",
	provider: type("string").atLeastLength(1),
	credential: writableAuthCredentialSchema,
});

export const credentialUploadResponseSchema: FluentType<CredentialUploadResponse> = type({
	"+": "reject",
	entries: credentialSnapshotEntrySchema.array(),
});
