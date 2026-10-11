import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthGatewayAuthorizer,
	type AuthGatewayServerHandle,
	startAuthGateway,
	withEnrollToken,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";

const ENROLL_TOKEN = "enroll-secret";
const STATE = "server-state";
const VERIFIER = "server-verifier";
const ANTHROPIC_REDIRECT = "http://localhost:54545/callback";

/** Stands in for the verify RPC: one agent token. */
const agentAuthorizer: AuthGatewayAuthorizer = req =>
	req.headers.get("authorization") === "Bearer agent-token" ? { kind: "agent", agentAccountId: "agent-a" } : null;

interface Harness {
	handle: AuthGatewayServerHandle;
	resolved: string[];
	providerCalls: string[];
	close(): Promise<void>;
}

let harness: Harness | undefined;

afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

async function boot(tokenEndpoint: (url: string) => Response = () => new Response("unexpected", { status: 500 })) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-enroll-"));
	const storage = await AuthStorage.create(path.join(dir, "pool.db"));
	storage.keys.setRuntime("openrouter", "key-a");
	const mock = createMockModel({ provider: "openrouter", id: "mock/enroll" });
	const resolved: string[] = [];
	const providerCalls: string[] = [];
	const fetchImpl: FetchImpl = async input => {
		const url = String(input);
		providerCalls.push(url);
		return tokenEndpoint(url);
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: withEnrollToken(ENROLL_TOKEN, agentAuthorizer),
		storage,
		resolveStorage: caller => {
			resolved.push(caller.agentAccountId);
			return storage;
		},
		resolveModel: () => mock.model,
		version: "test",
		fetch: fetchImpl,
	});
	harness = {
		handle,
		resolved,
		providerCalls,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
	return harness;
}

function call(h: Harness, route: string, token: string | undefined, body?: Record<string, unknown>): Promise<Response> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token !== undefined) headers.Authorization = `Bearer ${token}`;
	return fetch(`${h.handle.url}${route}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

const exchangeBody = (code: string) => ({
	provider: "anthropic",
	code,
	state: STATE,
	redirectUri: ANTHROPIC_REDIRECT,
	pkceVerifier: VERIFIER,
});

describe("auth-gateway enrollment routes", () => {
	it("answers 401 to every enroll route without the enroll token", async () => {
		const h = await boot();
		for (const route of [
			"/internal/enroll/providers",
			"/internal/enroll/authorize-url",
			"/internal/enroll/exchange",
		]) {
			expect((await call(h, route, undefined)).status).toBe(401);
		}
	});

	it("answers 401 to a valid agent bearer on the enroll routes", async () => {
		const h = await boot();
		expect((await call(h, "/internal/enroll/providers", "agent-token")).status).toBe(401);
		const exchange = await call(h, "/internal/enroll/exchange", "agent-token", exchangeBody("code"));
		expect(exchange.status).toBe(401);
		expect(h.providerCalls).toEqual([]);
	});

	it("answers 401 to the enroll token on the agent surface, before any pool is resolved", async () => {
		const h = await boot();
		for (const route of ["/v1/models", "/v1/usage", "/v1/credentials/check"]) {
			expect((await call(h, route, ENROLL_TOKEN)).status).toBe(401);
		}
		expect((await call(h, "/v1/chat/completions", ENROLL_TOKEN, { model: "mock/enroll", messages: [] })).status).toBe(
			401,
		);
		expect(h.resolved).toEqual([]);
		// The agent surface still serves agents.
		expect((await call(h, "/v1/models", "agent-token")).status).toBe(200);
	});

	it.each([
		["a prefix of it", ENROLL_TOKEN.slice(0, -1)],
		["it with a suffix", `${ENROLL_TOKEN}x`],
		["it with one byte changed", `${ENROLL_TOKEN.slice(0, -1)}X`],
	])("refuses %s as the enroll token", async (_label, token) => {
		const h = await boot();
		expect((await call(h, "/internal/enroll/providers", token)).status).toBe(401);
	});

	it.each([
		["empty", ""],
		["blank", " "],
		["padded", "enroll-secret\n"],
	])("refuses a %s enroll token at construction, since a trimmed bearer could never match it", (_label, token) => {
		expect(() => withEnrollToken(token, agentAuthorizer)).toThrow("enroll token must be non-empty");
	});

	it("lists each enrollable provider's paste-code flow and ToS tier", async () => {
		const h = await boot();
		const response = await call(h, "/internal/enroll/providers", ENROLL_TOKEN);
		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		expect(body).toEqual({
			providers: expect.arrayContaining([
				{ id: "anthropic", pasteCodeFlow: true, subscriptionTosTier: "restricted" },
				{ id: "openai-codex", pasteCodeFlow: true, subscriptionTosTier: "restricted" },
			]),
		});
		expect((body as { providers: unknown[] }).providers).toHaveLength(2);
	});

	it("builds the authorize URL from the server's state and PKCE challenge", async () => {
		const h = await boot();
		const response = await call(h, "/internal/enroll/authorize-url", ENROLL_TOKEN, {
			provider: "anthropic",
			state: STATE,
			redirectUri: ANTHROPIC_REDIRECT,
			pkceChallenge: "server-challenge",
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { url: string; instructions?: string };
		const url = new URL(body.url);
		expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
		expect(url.searchParams.get("state")).toBe(STATE);
		expect(url.searchParams.get("code_challenge")).toBe("server-challenge");
		expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT);
		expect(url.searchParams.get("code")).toBe("true");
		expect(body.instructions).toContain("paste");
	});

	it.each([
		["a missing field", { provider: "anthropic", state: STATE, redirectUri: ANTHROPIC_REDIRECT }, 400],
		[
			"an empty challenge",
			{ provider: "anthropic", state: STATE, redirectUri: ANTHROPIC_REDIRECT, pkceChallenge: "" },
			400,
		],
		[
			"a Codex redirect override",
			{ provider: "openai-codex", state: STATE, redirectUri: "http://localhost:9/cb", pkceChallenge: "c" },
			400,
		],
		[
			"an unknown provider",
			{ provider: "nope", state: STATE, redirectUri: ANTHROPIC_REDIRECT, pkceChallenge: "c" },
			404,
		],
		[
			"an inherited key as provider",
			{ provider: "constructor", state: STATE, redirectUri: ANTHROPIC_REDIRECT, pkceChallenge: "c" },
			404,
		],
	])("answers authorize-url with %s as a client error", async (_label, body, status) => {
		const h = await boot();
		expect((await call(h, "/internal/enroll/authorize-url", ENROLL_TOKEN, body)).status).toBe(status);
	});

	it("exchanges a pasted code#state with the server's verifier and returns the credential", async () => {
		const h = await boot(() =>
			Response.json({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
				account: { uuid: "account-7", email_address: "person@example.com" },
				organization: { uuid: "org-9", name: "Team" },
			}),
		);
		const response = await fetch(`${h.handle.url}/internal/enroll/exchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENROLL_TOKEN}` },
			body: JSON.stringify(exchangeBody(`authorization-code#${STATE}`)),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			credential: expect.objectContaining({
				access: "access-token",
				refresh: "refresh-token",
				accountId: "account-7",
				orgId: "org-9",
				orgName: "Team",
			}),
		});
		expect(h.providerCalls).toEqual(["https://api.anthropic.com/v1/oauth/token"]);
	});

	it("refuses a code whose echoed state is not the server's, before calling the provider", async () => {
		const h = await boot();
		const response = await call(
			h,
			"/internal/enroll/exchange",
			ENROLL_TOKEN,
			exchangeBody("authorization-code#other"),
		);
		expect(response.status).toBe(400);
		expect(h.providerCalls).toEqual([]);
	});

	it.each([
		["a rejected code", () => new Response('{"error":"invalid_grant","detail":"SECRET-BODY"}', { status: 400 }), 422],
		["a rate limit", () => new Response("SECRET-BODY", { status: 429 }), 503],
		["a request timeout", () => new Response("SECRET-BODY", { status: 408 }), 503],
		["a refused gateway client", () => new Response("SECRET-BODY", { status: 401 }), 502],
		["a provider 5xx", () => new Response("SECRET-BODY", { status: 503 }), 502],
		["a 200 with no token", () => Response.json({ detail: "SECRET-BODY" }), 502],
		[
			"an unreachable provider",
			() => {
				throw new Error("SECRET-BODY");
			},
			502,
		],
	])("classifies %s and never logs the provider body", async (_label, endpoint, status) => {
		const warn = spyOn(logger, "warn");
		try {
			const h = await boot(endpoint);
			const response = await call(h, "/internal/enroll/exchange", ENROLL_TOKEN, exchangeBody("authorization-code"));
			expect(response.status).toBe(status);
			expect(JSON.stringify(await response.json())).not.toContain("SECRET-BODY");
			expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-BODY");
			expect(JSON.stringify(warn.mock.calls)).not.toContain("authorization-code");
		} finally {
			warn.mockRestore();
		}
	});

	it("answers 404 to an unknown enroll path for the enroll caller", async () => {
		const h = await boot();
		expect((await call(h, "/internal/enroll/unknown", ENROLL_TOKEN)).status).toBe(404);
	});

	it.each([
		["an array", ["anthropic"]],
		["a string", "anthropic"],
		["null", null],
	])("answers 400 to %s as the exchange body", async (_label, body) => {
		const h = await boot();
		const response = await fetch(`${h.handle.url}/internal/enroll/exchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENROLL_TOKEN}` },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(400);
		expect(h.providerCalls).toEqual([]);
	});

	it("grants no browser CORS on enroll responses, which carry live credentials", async () => {
		const h = await boot();
		const response = await fetch(`${h.handle.url}/internal/enroll/providers`, {
			headers: { Authorization: `Bearer ${ENROLL_TOKEN}`, Origin: "https://evil.example" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});
});
