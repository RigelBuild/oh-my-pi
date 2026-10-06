/**
 * The server's provider-enrollment routes. The server owns state and PKCE; these
 * routes build the authorize URL and exchange the code statelessly.
 */
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { subscriptionTosTierForProvider } from "../../registry/derived";
import {
	createAnthropicEnrollmentAuthorizationUrl,
	createOpenAICodexEnrollmentAuthorizationUrl,
	exchangeAnthropicAuthorizationCode,
	exchangeOpenAICodexAuthorizationCode,
	type OAuthCodeAuthorizationArgs,
	type OAuthCodeExchangeArgs,
} from "../../registry/oauth/stateless";
import type { OAuthCredentials } from "../../registry/oauth/types";
import { PROVIDER_REGISTRY } from "../../registry/registry";
import type { FetchImpl } from "../../types";
import { json } from "../http";

export const ENROLL_PATH_PREFIX = "/internal/enroll/";

interface EnrollFlow {
	authorizeUrl(args: OAuthCodeAuthorizationArgs): Promise<{ url: string; instructions?: string }>;
	exchange(args: OAuthCodeExchangeArgs): Promise<OAuthCredentials>;
}

const ENROLL_FLOWS: Readonly<Record<string, EnrollFlow>> = {
	anthropic: {
		authorizeUrl: createAnthropicEnrollmentAuthorizationUrl,
		exchange: exchangeAnthropicAuthorizationCode,
	},
	"openai-codex": {
		authorizeUrl: createOpenAICodexEnrollmentAuthorizationUrl,
		exchange: exchangeOpenAICodexAuthorizationCode,
	},
};

type Fields<K extends string> = { [key in K]: string };

/** The JSON body's named string fields, or `undefined` if any is missing or not a string. */
async function readFields<K extends string>(req: Request, keys: readonly K[]): Promise<Fields<K> | undefined> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return undefined;
	}
	if (typeof body !== "object" || body === null) return undefined;
	const fields: Partial<Record<K, string>> = {};
	for (const key of keys) {
		const value: unknown = Reflect.get(body, key);
		if (typeof value !== "string") return undefined;
		fields[key] = value;
	}
	return fields as Fields<K>;
}

function flowFor(provider: string): EnrollFlow | undefined {
	return Object.hasOwn(ENROLL_FLOWS, provider) ? ENROLL_FLOWS[provider] : undefined;
}

/** Provider statuses that mean "try again later", not "this code is bad". */
const TRANSIENT_PROVIDER_STATUSES = new Set([408, 429]);

/** Token-endpoint statuses that blame the gateway's OAuth client, not the user's code. */
const CLIENT_FAULT_STATUSES = new Set([401, 403]);

/**
 * Maps a failed exchange to a status the server can act on: 400 bad input, 422 a code
 * the provider rejected, 503 retry later, 502/504 a provider fault. `contacted` says
 * whether the provider was called; a validation error after that is a bad provider response.
 */
function exchangeFailure(error: unknown, contacted: boolean): { status: number; error: string } {
	if (error instanceof AIError.OAuthError) {
		if (error.kind === "validation" && !contacted) return { status: 400, error: "invalid enrollment input" };
		if (error.kind === "timeout") return { status: 504, error: "provider timed out" };
		if (error.kind === "token-exchange" && error.status !== undefined) {
			if (TRANSIENT_PROVIDER_STATUSES.has(error.status)) return { status: 503, error: "provider busy, retry later" };
			if (CLIENT_FAULT_STATUSES.has(error.status))
				return { status: 502, error: "provider refused the gateway client" };
			if (error.status >= 400 && error.status < 500) {
				return { status: 422, error: "provider rejected the authorization code" };
			}
		}
	}
	return { status: 502, error: "provider exchange failed" };
}

/** A loggable label for a failure: its class and OAuth stage, never its message. */
function errorClass(error: unknown): string {
	if (error instanceof AIError.OAuthError) return `OAuthError:${error.kind}`;
	return error instanceof Error ? error.name : typeof error;
}

const AUTHORIZE_URL_FIELDS = ["provider", "state", "redirectUri", "pkceChallenge"] as const;
const EXCHANGE_FIELDS = ["provider", "code", "state", "redirectUri", "pkceVerifier"] as const;

/** Answers an `/internal/enroll/*` request; the caller has already been admitted as the enroll class. */
export async function handleEnroll(req: Request, pathname: string, fetchImpl?: FetchImpl): Promise<Response> {
	if (req.method === "GET" && pathname === "/internal/enroll/providers") {
		const providers = PROVIDER_REGISTRY.filter(provider => flowFor(provider.id)).map(provider => ({
			id: provider.id,
			pasteCodeFlow: provider.pasteCodeFlow === true,
			subscriptionTosTier: subscriptionTosTierForProvider(provider.id),
		}));
		return json(200, { providers });
	}
	if (req.method === "POST" && pathname === "/internal/enroll/authorize-url") {
		const fields = await readFields(req, AUTHORIZE_URL_FIELDS);
		if (!fields) return json(400, { error: "expected provider, state, redirectUri and pkceChallenge strings" });
		const flow = flowFor(fields.provider);
		if (!flow) return json(404, { error: "unknown enrollment provider" });
		try {
			const result = await flow.authorizeUrl({ ...fields, signal: req.signal });
			return json(200, result);
		} catch (error) {
			if (error instanceof AIError.LoginCancelledError) return new Response(null, { status: 499 });
			if (error instanceof AIError.OAuthError && error.kind === "validation") {
				return json(400, { error: "invalid enrollment input" });
			}
			throw error;
		}
	}
	if (req.method === "POST" && pathname === "/internal/enroll/exchange") {
		const fields = await readFields(req, EXCHANGE_FIELDS);
		if (!fields) return json(400, { error: "expected provider, code, state, redirectUri and pkceVerifier strings" });
		const flow = flowFor(fields.provider);
		if (!flow) return json(404, { error: "unknown enrollment provider" });
		let contacted = false;
		const upstream = fetchImpl ?? fetch;
		const tracked: FetchImpl = (input, init) => {
			contacted = true;
			return upstream(input, init);
		};
		try {
			const credential = await flow.exchange({ ...fields, signal: req.signal, fetch: tracked });
			return json(200, { credential });
		} catch (error) {
			if (error instanceof AIError.LoginCancelledError) return new Response(null, { status: 499 });
			const failure = exchangeFailure(error, contacted);
			// The error text may carry the provider's response body, so only its class is logged.
			logger.warn("auth-gateway enrollment exchange failed", {
				provider: fields.provider,
				status: failure.status,
				error: errorClass(error),
			});
			return json(failure.status, { error: failure.error });
		}
	}
	return json(404, { error: `No route: ${req.method} ${pathname}` });
}
