import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { CompiledOAuthCodeLogin } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import {
	applyAfterExchange,
	applyUserinfo,
	mapCredentials,
	postTokenRequest,
	resolveValue,
	template,
	type TemplateVars,
	throwIfCancelled,
} from "../engine/common";
import type { OAuthCredentials, OAuthPrompt } from "./types";
import { parseCallbackInput } from "./callback-server";

export interface OAuthCodeAuthorizationArgs {
	state: string;
	redirectUri: string;
	pkceChallenge: string;
	signal?: AbortSignal;
}

export interface OAuthCodeExchangeArgs {
	code: string;
	state: string;
	redirectUri: string;
	pkceVerifier: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthCodeFlowSettings {
	clientId?: string;
	clientSecret?: string;
	base?: string;
	auth?: string;
	authorizeUrl: string;
}

function oauthCodePolicy(provider: "anthropic" | "openai-codex"): CompiledOAuthCodeLogin {
	const rule = authPolicyFor(provider)?.login;
	if (!rule || rule.kind !== "oauth-code") {
		throw new AIError.OAuthError(`Provider ${provider} has no authorization-code OAuth flow`, {
			kind: "validation",
			provider,
		});
	}
	return rule;
}

export async function resolveOAuthCodeFlowSettings(
	rule: CompiledOAuthCodeLogin,
	signal?: AbortSignal,
): Promise<OAuthCodeFlowSettings> {
	return {
		...(rule.clientId ? { clientId: await resolveValue(rule.clientId, signal) } : {}),
		...(rule.clientSecret ? { clientSecret: await resolveValue(rule.clientSecret, signal) } : {}),
		...(rule.baseUrl ? { base: (await resolveValue(rule.baseUrl, signal)).replace(/\/+$/, "") } : {}),
		...(rule.authUrl ? { auth: (await resolveValue(rule.authUrl, signal)).replace(/\/+$/, "") } : {}),
		authorizeUrl: await resolveValue(rule.authorizeUrl, signal),
	};
}

export function createOAuthCodeFlowAuthorizationUrl(
	rule: CompiledOAuthCodeLogin,
	settings: OAuthCodeFlowSettings,
	args: OAuthCodeAuthorizationArgs,
): { url: string; instructions?: string } {
	const scope = rule.scopes.length > 0 ? rule.scopes.join(rule.scopeSeparator) : undefined;
	const vars: TemplateVars = {
		client_id: settings.clientId,
		redirect_uri: args.redirectUri,
		scope,
		state: args.state,
		code_challenge: rule.pkce ? args.pkceChallenge : undefined,
		base: settings.base,
		auth: settings.auth,
	};
	const params = new URLSearchParams();
	if (rule.standardAuthorizeParams) {
		if (settings.clientId) params.set("client_id", settings.clientId);
		params.set("response_type", "code");
		params.set("redirect_uri", args.redirectUri);
		if (scope) params.set("scope", scope);
		if (rule.pkce) {
			params.set("code_challenge", args.pkceChallenge);
			params.set("code_challenge_method", "S256");
		}
		if (args.state) params.set("state", args.state);
	}
	for (const key in rule.authorizeParams) params.set(key, template(rule.authorizeParams[key] ?? "", vars));
	return {
		url: `${template(settings.authorizeUrl, vars)}?${params.toString()}`,
		...(rule.instructions ? { instructions: rule.instructions } : {}),
	};
}

export async function exchangeOAuthCodeFlow(
	provider: string,
	rule: CompiledOAuthCodeLogin,
	settings: OAuthCodeFlowSettings,
	args: OAuthCodeExchangeArgs,
): Promise<OAuthCredentials> {
	const fetchImpl = args.fetch ?? fetch;
	throwIfCancelled(args.signal);
	let exchangeCode = args.code;
	let exchangeState = args.state;
	const fragment = exchangeCode.indexOf("#");
	if (fragment >= 0) {
		exchangeState = exchangeCode.slice(fragment + 1) || exchangeState;
		exchangeCode = exchangeCode.slice(0, fragment);
	}
	const vars: TemplateVars = {
		code: exchangeCode,
		state: exchangeState,
		redirect_uri: args.redirectUri,
		code_verifier: rule.pkce ? args.pkceVerifier : undefined,
		client_id: settings.clientId,
		client_secret: settings.clientSecret,
		base: settings.base,
		auth: settings.auth,
	};
	const context = { provider, fetch: fetchImpl, signal: args.signal };
	const { body } = await postTokenRequest(
		rule.token,
		{
			grant_type: "authorization_code",
			client_id: settings.clientId,
			client_secret: settings.clientSecret,
			code: exchangeCode,
			redirect_uri: args.redirectUri,
			code_verifier: rule.pkce ? args.pkceVerifier : undefined,
		},
		vars,
		context,
		"token-exchange",
	);
	throwIfCancelled(args.signal);
	let credentials = mapCredentials(rule.credential, body, provider);
	credentials = await applyUserinfo(rule.userinfo, credentials, context, vars);
	throwIfCancelled(args.signal);
	return applyAfterExchange(rule.afterExchange, credentials, {
		provider,
		phase: "login",
		raw: body,
		fetch: fetchImpl,
		signal: args.signal,
		onProgress: args.onProgress,
		onPrompt: args.onPrompt,
	});
}

function assertEnrollmentInputs(
	provider: "anthropic" | "openai-codex",
	args: OAuthCodeAuthorizationArgs | OAuthCodeExchangeArgs,
): void {
	if (!args.state.trim())
		throw new AIError.OAuthError("OAuth state must not be empty", { kind: "validation", provider });
	if ("pkceChallenge" in args && !args.pkceChallenge.trim()) {
		throw new AIError.OAuthError("PKCE challenge must not be empty", { kind: "validation", provider });
	}
	if ("pkceVerifier" in args && !args.pkceVerifier.trim()) {
		throw new AIError.OAuthError("PKCE verifier must not be empty", { kind: "validation", provider });
	}
	if (provider === "openai-codex" && args.redirectUri !== "http://localhost:1455/auth/callback") {
		throw new AIError.OAuthError("Codex requires its fixed callback URI", { kind: "validation", provider });
	}
}

async function createEnrollmentAuthorizationUrl(
	provider: "anthropic" | "openai-codex",
	args: OAuthCodeAuthorizationArgs,
): Promise<{ url: string; instructions?: string }> {
	assertEnrollmentInputs(provider, args);
	const rule = oauthCodePolicy(provider);
	const settings = await resolveOAuthCodeFlowSettings(rule, args.signal);
	return createOAuthCodeFlowAuthorizationUrl(rule, settings, args);
}

async function exchangeEnrollmentCode(
	provider: "anthropic" | "openai-codex",
	args: OAuthCodeExchangeArgs,
): Promise<OAuthCredentials> {
	assertEnrollmentInputs(provider, args);
	const raw = args.code.trim();
	const parsed = parseCallbackInput(raw);
	// A bare pasted code is PKCE-bound only; any callback shape that carries state must echo ours.
	const carriesState = raw.includes("#") || raw.includes("code=") || URL.canParse(raw);
	if (!parsed.code || (carriesState && parsed.state !== args.state)) {
		throw new AIError.OAuthError("OAuth callback code or state is invalid", { kind: "validation", provider });
	}
	const rule = oauthCodePolicy(provider);
	const settings = await resolveOAuthCodeFlowSettings(rule, args.signal);
	return exchangeOAuthCodeFlow(provider, rule, settings, { ...args, code: parsed.code });
}

/** Create Anthropic's authorization URL without retaining its state or verifier. */
export function createAnthropicEnrollmentAuthorizationUrl(
	args: OAuthCodeAuthorizationArgs,
): Promise<{ url: string; instructions?: string }> {
	return createEnrollmentAuthorizationUrl("anthropic", args);
}

/** Exchange Anthropic authorization code using caller-owned state and PKCE verifier. */
export function exchangeAnthropicAuthorizationCode(args: OAuthCodeExchangeArgs): Promise<OAuthCredentials> {
	return exchangeEnrollmentCode("anthropic", args);
}

/** Create Codex's authorization URL without retaining its state or verifier. */
export function createOpenAICodexEnrollmentAuthorizationUrl(
	args: OAuthCodeAuthorizationArgs,
): Promise<{ url: string; instructions?: string }> {
	return createEnrollmentAuthorizationUrl("openai-codex", args);
}

/** Exchange Codex authorization code using caller-owned state and PKCE verifier. */
export function exchangeOpenAICodexAuthorizationCode(args: OAuthCodeExchangeArgs): Promise<OAuthCredentials> {
	return exchangeEnrollmentCode("openai-codex", args);
}
