/**
 * `login "oauth-code"` engine: authorization-code grant (optionally PKCE)
 * through the configured callback transport, followed by the declared token
 * exchange, credential projection, userinfo enrichment and after-exchange hook.
 */
import type { CompiledAuthProvider, CompiledCallback, CompiledOAuthCodeLogin } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { validateApiKeyAgainstModelsEndpoint } from "../api-key-validation";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "../oauth/callback-server";
import { generatePKCE } from "../oauth/pkce";
import type { OAuthController, OAuthCredentials } from "../oauth/types";
import {
	createOAuthCodeFlowAuthorizationUrl,
	exchangeOAuthCodeFlow,
	resolveOAuthCodeFlowSettings,
	type OAuthCodeFlowSettings,
} from "../oauth/stateless";
import { NEVER_EXPIRES, resolveValue, throwIfCancelled } from "./common";

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Callback-server options for a rule. A `redirect-uri-env` override is
 * advertised verbatim with random-port fallback disabled; HTTP loopback
 * overrides also bind the listener to the URI's host/port/path.
 */
export async function resolveCallbackOptions(
	callback: CompiledCallback,
	provider: string,
	signal?: AbortSignal,
): Promise<OAuthCallbackFlowOptions> {
	const base: OAuthCallbackFlowOptions = {
		preferredPort: callback.port,
		callbackPath: callback.path,
		callbackHostname: callback.hostname,
		allowPortFallback: callback.portFallback,
		manualInputOnly: callback.manualOnly,
		nativeScheme: callback.nativeScheme,
	};
	if (!callback.redirectUri) return base;
	const redirectUri = await resolveValue(callback.redirectUri, signal);
	if (!redirectUri) return base;
	if (redirectUri === callback.redirectUri.value) {
		return { ...base, redirectUri };
	}
	let parsed: URL;
	try {
		parsed = new URL(redirectUri);
	} catch {
		throw new AIError.OAuthError(`Invalid redirect URI override: ${redirectUri}`, {
			kind: "configuration",
			provider,
		});
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Redirect URI override must use http:// or https://, got: ${redirectUri}`, {
			kind: "configuration",
			provider,
		});
	}
	const loopback = isLoopbackHost(parsed.hostname);
	if (loopback && parsed.protocol !== "http:") {
		throw new AIError.OAuthError(`Loopback redirect URI overrides must use http://, got: ${redirectUri}`, {
			kind: "configuration",
			provider,
		});
	}
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
	return {
		preferredPort: loopback ? port : 0,
		callbackPath: parsed.pathname || callback.path,
		callbackHostname: loopback ? parsed.hostname : callback.hostname,
		redirectUri,
		allowPortFallback: false,
		manualInputOnly: callback.manualOnly,
		nativeScheme: callback.nativeScheme,
	};
}

/** Generic authorization-code flow driven by one compiled rule. */
export class DeclarativeOAuthCodeFlow extends OAuthCallbackFlow {
	#rule: CompiledOAuthCodeLogin;
	#provider: string;
	#label: string;
	#fetch: FetchImpl;
	#verifier = "";
	#settings?: OAuthCodeFlowSettings;

	constructor(
		ctrl: OAuthController,
		rule: CompiledOAuthCodeLogin,
		policy: CompiledAuthProvider,
		options: OAuthCallbackFlowOptions,
	) {
		super(ctrl, options);
		this.#rule = rule;
		this.#provider = policy.id;
		this.#label = policy.name;
		this.#fetch = ctrl.fetch ?? fetch;
	}

	override generateState(): string {
		switch (this.#rule.state) {
			case "none":
				return "";
			case "uuid":
				return crypto.randomUUID();
			default:
				return super.generateState();
		}
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const signal = this.ctrl.signal;
		this.#settings = await resolveOAuthCodeFlowSettings(this.#rule, signal);
		const pkce = this.#rule.pkce ? await generatePKCE() : undefined;
		this.#verifier = pkce?.verifier ?? "";
		return createOAuthCodeFlowAuthorizationUrl(this.#rule, this.#settings, {
			state,
			redirectUri,
			pkceChallenge: pkce?.challenge ?? "",
			signal,
		});
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		const signal = this.ctrl.signal;
		throwIfCancelled(signal);
		if (this.#rule.pasteKey && code.startsWith(this.#rule.pasteKey.prefix)) {
			await validateApiKeyAgainstModelsEndpoint({
				provider: this.#label,
				apiKey: code,
				modelsUrl: this.#rule.pasteKey.validateUrl,
				signal,
				fetch: this.ctrl.fetch,
			});
			return { access: code, refresh: "", expires: NEVER_EXPIRES };
		}
		const settings = this.#settings ?? (await resolveOAuthCodeFlowSettings(this.#rule, signal));
		return exchangeOAuthCodeFlow(this.#provider, this.#rule, settings, {
			code,
			state,
			redirectUri,
			pkceVerifier: this.#verifier,
			fetch: this.#fetch,
			signal,
			onProgress: this.ctrl.onProgress,
			onPrompt: this.ctrl.onPrompt,
		});
	}
}
/** Builds the login function for one `login "oauth-code"` rule. */
export function createOAuthCodeLogin(
	rule: CompiledOAuthCodeLogin,
	policy: CompiledAuthProvider,
): (ctrl: OAuthController) => Promise<OAuthCredentials> {
	return async ctrl => {
		const options = await resolveCallbackOptions(rule.callback, policy.id, ctrl.signal);
		return new DeclarativeOAuthCodeFlow(ctrl, rule, policy, options).login();
	};
}
