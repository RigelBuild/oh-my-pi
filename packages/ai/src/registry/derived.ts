import { PROVIDER_REGISTRY } from "./registry";

/**
 * Providers whose OAuth flow needs a pasted code/redirect URL rather than a
 * local callback server. Consumed by the coding-agent login UX.
 */
export const PASTE_CODE_LOGIN_PROVIDERS: ReadonlySet<string> = new Set(
	PROVIDER_REGISTRY.filter(p => p.pasteCodeFlow).map(p => p.id),
);

/** Providers explicitly classified as restricted-tier subscription OAuth. */
export const RESTRICTED_SUBSCRIPTION_OAUTH_PROVIDERS: ReadonlySet<string> = new Set(
	PROVIDER_REGISTRY.filter(provider => provider.subscriptionTosTier === "restricted").map(provider => provider.id),
);

/** Enrollment wire tier for a provider, defaulting absent declarations to restricted. */
export function subscriptionTosTierForProvider(providerId: string): "permissive" | "restricted" {
	return PROVIDER_REGISTRY.find(provider => provider.id === providerId)?.subscriptionTosTier ?? "restricted";
}
