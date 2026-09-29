import { describe, expect, it, vi } from "bun:test";
import {
	createAnthropicEnrollmentAuthorizationUrl,
	createOpenAICodexEnrollmentAuthorizationUrl,
	exchangeAnthropicAuthorizationCode,
	exchangeOpenAICodexAuthorizationCode,
} from "@oh-my-pi/pi-ai/registry/oauth/stateless";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const STATE = "caller-state";
const CHALLENGE = "caller-challenge";
const VERIFIER = "caller-verifier";

function readForm(init: RequestInit | undefined): URLSearchParams {
	const body = init?.body;
	if (typeof body !== "string") throw new Error("expected form-encoded OAuth request");
	return new URLSearchParams(body);
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("stateless provider OAuth flows", () => {
	it("builds Anthropic authorize URL from the KDL contract and caller-owned PKCE challenge", async () => {
		const result = await createAnthropicEnrollmentAuthorizationUrl({
			state: STATE,
			redirectUri: "http://localhost:54545/callback",
			pkceChallenge: CHALLENGE,
		});
		const url = new URL(result.url);

		expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
		expect(url.searchParams.get("state")).toBe(STATE);
		expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code")).toBe("true");
		expect(url.searchParams.get("scope")).toContain("user:inference");
		expect(result.instructions).toContain("paste");
	});

	it("exchanges Anthropic code#state with caller verifier and retains mapped organization credentials", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				return jsonResponse({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: { uuid: "account-7", email_address: "person@example.com" },
					organization: { uuid: "org-9", name: "Team" },
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		const credentials = await exchangeAnthropicAuthorizationCode({
			code: "authorization-code#fragment-state",
			state: STATE,
			redirectUri: "http://localhost:54545/callback",
			pkceVerifier: VERIFIER,
			fetch: fetchMock,
		});

		const request = requests[0];
		const form = request ? (JSON.parse(String(request.init?.body)) as Record<string, unknown>) : {};
		expect(request?.url).toBe("https://api.anthropic.com/v1/oauth/token");
		expect(form).toMatchObject({ code: "authorization-code", state: "fragment-state", code_verifier: VERIFIER });
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			accountId: "account-7",
			email: "person@example.com",
			orgId: "org-9",
			orgName: "Team",
		});
	});

	it("builds Codex authorize parameters from KDL and the caller-owned challenge", async () => {
		const result = await createOpenAICodexEnrollmentAuthorizationUrl({
			state: STATE,
			redirectUri: "http://localhost:1455/auth/callback",
			pkceChallenge: CHALLENGE,
		});
		const url = new URL(result.url);

		expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("state")).toBe(STATE);
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(url.searchParams.get("originator")).toBe("omp");
	});

	it("exchanges Codex code using the caller verifier and projects JWT identity", async () => {
		const jwt = (payload: Record<string, unknown>) =>
			`${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
		const access = jwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "workspace-4", chatgpt_plan_type: "plus" },
			"https://api.openai.com/profile": { email: "Person@Example.com" },
		});
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://auth.openai.com/oauth/token") {
				return jsonResponse({ access_token: access, refresh_token: "refresh-token", expires_in: 3600 });
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		const credentials = await exchangeOpenAICodexAuthorizationCode({
			code: "codex-code",
			state: STATE,
			redirectUri: "http://localhost:1455/auth/callback",
			pkceVerifier: VERIFIER,
			fetch: fetchMock,
		});
		const request = requests[0];
		const form = readForm(request?.init);

		expect(request?.url).toBe("https://auth.openai.com/oauth/token");
		expect(form.get("code")).toBe("codex-code");
		expect(form.get("code_verifier")).toBe(VERIFIER);
		expect(credentials).toMatchObject({
			access,
			refresh: "refresh-token",
			accountId: "workspace-4",
			orgId: "workspace-4",
			orgName: "plus",
			email: "person@example.com",
		});
	});
});
