import { type, type FluentType } from "@oh-my-pi/omptype";

export type GatewayInt64 = string | number;
export type GatewayCredentialScope = "GATEWAY_CREDENTIAL_SCOPE_OWN" | "GATEWAY_CREDENTIAL_SCOPE_SHARED";

export interface GatewayOAuthToken {
	access?: string;
	refresh?: string;
	expiresUnixMs?: GatewayInt64;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
	apiEndpoint?: string;
	orgId?: string;
	orgName?: string;
	authorizedAtUnixMs?: GatewayInt64;
}

export interface GatewayCredential {
	id: string;
	provider: string;
	scope?: GatewayCredentialScope;
	version: GatewayInt64;
	apiKey?: string;
	oauth?: GatewayOAuthToken;
}

export interface ListCredentialPoolRequest {
	agentAccountId: string;
	provider?: string;
}

export interface ListCredentialPoolResponse {
	credentials?: GatewayCredential[];
}

export interface GatewayOAuthTokenRequest {
	access: string;
	refresh: string;
	expiresUnixMs: GatewayInt64;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
	apiEndpoint?: string;
	orgId?: string;
	orgName?: string;
	authorizedAtUnixMs?: GatewayInt64;
}

export interface UpdateCredentialOAuthRequest {
	id: string;
	token: GatewayOAuthTokenRequest;
	expectedVersion: GatewayInt64;
}

export interface UpdateCredentialOAuthResponse {
	version: GatewayInt64;
}

export interface DisableCredentialRequest {
	id: string;
	cause: string;
	expectedVersion: GatewayInt64;
}

export type DisableCredentialResponse = Record<string, never>;

interface CompassRpcErrorResponse {
	code: string;
	message?: string;
}

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;
const int64Schema = type("number | string").narrow((value, ctx) => {
	let parsed: bigint;
	try {
		parsed = BigInt(value);
	} catch {
		return ctx.mustBe("a decimal int64");
	}
	return (parsed >= MIN_INT64 && parsed <= MAX_INT64) || ctx.mustBe("a decimal int64");
});
const versionSchema = int64Schema.narrow(
	(value, ctx) => (typeof value === "string" ? BigInt(value) > 0n : value >= 1) || ctx.mustBe("at least 1"),
);

export const gatewayOAuthTokenSchema: FluentType<GatewayOAuthToken> = type({
	"+": "delete",
	"access?": "string",
	"refresh?": "string",
	"expiresUnixMs?": int64Schema,
	"enterpriseUrl?": "string",
	"projectId?": "string",
	"email?": "string",
	"accountId?": "string",
	"apiEndpoint?": "string",
	"orgId?": "string",
	"orgName?": "string",
	"authorizedAtUnixMs?": int64Schema,
});

export const gatewayCredentialSchema: FluentType<GatewayCredential> = type({
	"+": "delete",
	id: "string",
	provider: "string",
	"scope?": "'GATEWAY_CREDENTIAL_SCOPE_OWN' | 'GATEWAY_CREDENTIAL_SCOPE_SHARED'",
	version: versionSchema,
	"apiKey?": "string",
	"oauth?": gatewayOAuthTokenSchema,
}).narrow(
	(credential, ctx) =>
		!(credential.apiKey !== undefined && credential.oauth !== undefined) || ctx.mustBe("one credential payload"),
);

export const listCredentialPoolResponseSchema: FluentType<ListCredentialPoolResponse> = type({
	"+": "delete",
	"credentials?": gatewayCredentialSchema.array(),
});

export const updateCredentialOAuthResponseSchema: FluentType<UpdateCredentialOAuthResponse> = type({
	"+": "delete",
	version: versionSchema,
});

export const disableCredentialResponseSchema: FluentType<DisableCredentialResponse> = type({
	"+": "delete",
});

const compassRpcErrorResponseSchema: FluentType<CompassRpcErrorResponse> = type({
	"+": "delete",
	code: "string",
	"message?": "string",
});

export class CompassRpcError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options: { cause?: unknown } = {}) {
		super(message, options);
		this.name = "CompassRpcError";
		this.code = code;
	}
}

export function decodeCompassJson<T>(text: string, schema: FluentType<T>): T {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// The parser's message quotes body fragments, which may hold credential values.
		throw new CompassRpcError("invalid_response", "Compass RPC returned malformed JSON");
	}
	const decoded = schema(raw);
	if (decoded instanceof type.errors) {
		throw new CompassRpcError("invalid_response", "Compass RPC response failed validation");
	}
	return decoded;
}

// Connect's HTTP-status fallback for bodies that are not Connect errors (e.g. proxy pages).
function connectCodeForStatus(status: number): string {
	switch (status) {
		case 400:
			return "internal";
		case 401:
			return "unauthenticated";
		case 403:
			return "permission_denied";
		case 404:
			return "unimplemented";
		case 429:
		case 502:
		case 503:
		case 504:
			return "unavailable";
		default:
			return "unknown";
	}
}

export function compassRpcErrorFromResponse(status: number, text: string): CompassRpcError {
	const fallback = `Compass RPC failed with HTTP ${status}`;
	try {
		const error = decodeCompassJson(text, compassRpcErrorResponseSchema);
		return new CompassRpcError(error.code, error.message ?? fallback);
	} catch {
		return new CompassRpcError(connectCodeForStatus(status), fallback);
	}
}
