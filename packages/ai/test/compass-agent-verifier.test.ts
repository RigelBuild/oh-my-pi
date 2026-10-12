import { describe, expect, test } from "bun:test";
import { createCompassAgentVerifier, probeCompassDoor } from "@oh-my-pi/pi-ai/compass";
import type { AgentCaller, AuthGatewayAuthorizer } from "@oh-my-pi/pi-ai/auth-gateway";

const SERVICE_TOKEN = "service-secret";
const AGENT_TOKEN = "agent-secret";
const RESPONSE = { agentAccountId: "agent-1", ownerUserId: "owner-1" };

interface RpcCall {
	input: string | URL | Request;
	init: RequestInit | undefined;
	body: unknown;
}

function response(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function verifier(fetcher: typeof fetch): AuthGatewayAuthorizer {
	return createCompassAgentVerifier({
		baseUrl: "https://compass.example/",
		token: SERVICE_TOKEN,
		fetch: fetcher,
	});
}

function makeFetch(answer: (call: RpcCall) => Response | Promise<Response>, calls: RpcCall[]): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body: unknown = JSON.parse(String(init?.body));
			const call: RpcCall = { input, init, body };
			calls.push(call);
			return answer(call);
		},
		{ preconnect: fetch.preconnect },
	);
}

describe("Compass agent verifier", () => {
	test("returns null without a bearer and makes no call", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(makeFetch(() => response(RESPONSE), calls));

		expect(await authorize(new Request("https://gateway.example/v1/models"))).toBeNull();
		expect(calls).toHaveLength(0);
	});

	test("maps a successful verification and sends the service bearer and presented token", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(makeFetch(() => response(RESPONSE), calls));
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		const caller = await authorize(req);
		expect(caller).toEqual({ kind: "agent", ...RESPONSE } satisfies AgentCaller);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("expected one verification call");
		expect(String(call.input)).toBe("https://compass.example/compass.v1.GatewayAuth/VerifyAgentToken");
		expect(call.init?.method).toBe("POST");
		expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
		expect(new Headers(call.init?.headers).get("content-type")).toBe("application/json");
		expect(new Headers(call.init?.headers).get("connect-protocol-version")).toBe("1");
		expect(call.body).toEqual({ token: AGENT_TOKEN });
	});

	test("maps only the exact invalid-agent-token unauthenticated response to null", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(
			makeFetch(() => response({ code: "unauthenticated", message: "invalid agent token" }, 401), calls),
		);
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		expect(await authorize(req)).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("verifies the bearer on every request without caching", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(makeFetch(() => response(RESPONSE), calls));
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		await authorize(req);
		await authorize(req);
		expect(calls).toHaveLength(2);
	});

	for (const message of ["unauthenticated", "invalid agent token but not exact"]) {
		test(`throws for a different unauthenticated response: ${message}`, async () => {
			const calls: RpcCall[] = [];
			const authorize = verifier(makeFetch(() => response({ code: "unauthenticated", message }, 401), calls));
			const req = new Request("https://gateway.example/v1/models", {
				headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
			});

			await expect(authorize(req)).rejects.toThrow();
			expect(calls).toHaveLength(1);
		});
	}

	test("throws when Compass reports unavailable", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(makeFetch(() => response({ code: "unavailable", message: "offline" }, 503), calls));
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		await expect(authorize(req)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test("throws for a transport error without exposing tokens", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(
			makeFetch(() => {
				throw new Error(`${SERVICE_TOKEN} ${AGENT_TOKEN}`);
			}, calls),
		);
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		const error = await Promise.resolve(authorize(req)).then(
			() => null,
			value => value,
		);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) throw new Error("expected a transport error");
		expect(error.message).not.toContain(SERVICE_TOKEN);
		expect(error.message).not.toContain(AGENT_TOKEN);
		expect(calls).toHaveLength(1);
	});

	test("throws for an internal Compass error", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(
			makeFetch(() => response({ code: "internal", message: "backend failed" }, 500), calls),
		);
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		await expect(authorize(req)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test("throws when the remote call times out", async () => {
		const calls: RpcCall[] = [];
		const fetcher = makeFetch(call => {
			const signal = call.init?.signal;
			if (!signal) throw new Error("missing timeout signal");
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}, calls);
		const authorize = createCompassAgentVerifier({
			baseUrl: "https://compass.example",
			token: SERVICE_TOKEN,
			fetch: fetcher,
			timeoutMs: 10,
		});
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		await expect(authorize(req)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test("cancels the remote call when the incoming request aborts", async () => {
		const calls: RpcCall[] = [];
		let remoteSignal: AbortSignal | null | undefined;
		const fetcher = makeFetch(call => {
			remoteSignal = call.init?.signal;
			if (!remoteSignal) throw new Error("missing request signal");
			return new Promise<Response>((_resolve, reject) => {
				remoteSignal?.addEventListener("abort", () => reject(remoteSignal?.reason), { once: true });
			});
		}, calls);
		const authorize = verifier(fetcher);
		const controller = new AbortController();
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
			signal: controller.signal,
		});
		const pending = authorize(req);
		await Promise.resolve();
		controller.abort();

		await expect(pending).rejects.toThrow();
		expect(remoteSignal?.aborted).toBe(true);
		expect(calls).toHaveLength(1);
	});

	test("rejects a successful response with an empty agentAccountId", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(makeFetch(() => response({ ...RESPONSE, agentAccountId: "" }), calls));
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		await expect(authorize(req)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test("rejects a successful response with an empty ownerUserId", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(makeFetch(() => response({ ...RESPONSE, ownerUserId: "" }), calls));
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});

		await expect(authorize(req)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	test("probe resolves only for the exact invalid-agent-token response", async () => {
		const calls: RpcCall[] = [];
		const opts = {
			baseUrl: "https://compass.example",
			token: SERVICE_TOKEN,
			fetch: makeFetch(() => response({ code: "unauthenticated", message: "invalid agent token" }, 401), calls),
		};

		await expect(probeCompassDoor(opts)).resolves.toBeUndefined();
		const call = calls[0];
		if (!call) throw new Error("expected one probe call");
		expect(call.body).toEqual({ token: "" });

		const successCalls: RpcCall[] = [];
		await expect(
			probeCompassDoor({ ...opts, fetch: makeFetch(() => response(RESPONSE), successCalls) }),
		).rejects.toThrow();
		expect(successCalls).toHaveLength(1);

		const otherErrorCalls: RpcCall[] = [];
		await expect(
			probeCompassDoor({
				...opts,
				fetch: makeFetch(
					() => response({ code: "unauthenticated", message: "unauthenticated" }, 401),
					otherErrorCalls,
				),
			}),
		).rejects.toThrow();
		expect(otherErrorCalls).toHaveLength(1);
	});

	test("does not expose either token in Compass error messages", async () => {
		const calls: RpcCall[] = [];
		const authorize = verifier(
			makeFetch(() => response({ code: "internal", message: `${SERVICE_TOKEN} ${AGENT_TOKEN}` }, 500), calls),
		);
		const req = new Request("https://gateway.example/v1/models", {
			headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
		});
		const error = await Promise.resolve(authorize(req)).then(
			() => null,
			value => value,
		);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) throw new Error("expected a Compass RPC error");
		expect(error.message).not.toContain(SERVICE_TOKEN);
		expect(error.message).not.toContain(AGENT_TOKEN);
		expect(calls).toHaveLength(1);
	});
});
