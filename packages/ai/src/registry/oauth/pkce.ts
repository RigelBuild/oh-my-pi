/** PKCE helpers. The caller-owned verifier can be paired across stateless OAuth requests. */
/** Derive the S256 challenge for a caller-owned PKCE verifier. */
export async function generatePKCEChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Buffer.from(hashBuffer).toString("base64url");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(96);
	crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");

	const challenge = await generatePKCEChallenge(verifier);

	return { verifier, challenge };
}
