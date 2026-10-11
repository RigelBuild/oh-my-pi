import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createAuthGatewayRouter, SHARED_TOKEN_CALLER } from "@oh-my-pi/pi-ai/auth-gateway";
import { resolveGatewayApiKey } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthGatewaySessionStateStore } from "@oh-my-pi/pi-ai/auth-gateway/session-state";
import type { ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { logger } from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

// A provider no registry entry knows, so no env var can supply a key behind the test's back.
const PROVIDER = "gw-setup-failure-test";
const MODEL_ID = "gw-setup-failure-model";
const STORE_DOWN = "HTTP 503 broker unavailable";

let dir: string;
let storage: AuthStorage;
let mock: MockModel;

beforeEach(async () => {
	registerMockApi();
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-setup-failure-"));
	storage = await AuthStorage.create(path.join(dir, "auth.db"));
	mock = createMockModel({ provider: PROVIDER, id: MODEL_ID });
	vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	storage.close();
	await fs.rm(dir, { recursive: true, force: true });
	clearCustomApis();
});

describe("resolveGatewayApiKey setup failures", () => {
	it("tags an empty pool as no_credential", async () => {
		await withEnv({ OPENAI_API_KEY: undefined }, async () => {
			const result = await resolveGatewayApiKey(storage, mock, "session", new AbortController().signal, "peer");
			expect(result).toEqual({
				status: 401,
				type: "authentication_error",
				message: `No credential available for provider ${PROVIDER}`,
				setupReason: "no_credential",
			});
		});
	});

	it("tags a throwing store as store_error", async () => {
		vi.spyOn(storage.keys, "getWithCredential").mockRejectedValue(new Error(STORE_DOWN));
		const result = await resolveGatewayApiKey(storage, mock, "session", new AbortController().signal, "peer");
		expect(result).toMatchObject({ status: 503, setupReason: "store_error" });
	});
});

const ROUTES = [
	{
		name: "format route",
		path: "/v1/chat/completions",
		body: { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] },
		noCredentialBody: {
			error: { message: `No credential available for provider ${PROVIDER}`, type: "authentication_error" },
		},
		abortedBody: { error: { message: "client closed request", type: "request_aborted" } },
	},
	{
		name: "pi-native",
		path: "/v1/pi/stream",
		body: { modelId: MODEL_ID, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } },
		noCredentialBody: {
			error: { type: "authentication_error", message: `No credential available for provider ${PROVIDER}` },
		},
		abortedBody: { error: { type: "request_aborted", message: "client closed request" } },
	},
];

describe.each(ROUTES)("$name setup failures", route => {
	function send(signal?: AbortSignal): Promise<Response> {
		const router = createAuthGatewayRouter({ storage, resolveModel: () => mock });
		const req = new Request(`http://gateway${route.path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(route.body),
			signal,
		});
		return router.route(req, "test", SHARED_TOKEN_CALLER);
	}

	it("answers a missing credential with the 401 envelope", async () => {
		const response = await send();
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(route.noCredentialBody);
		expect(mock.calls).toHaveLength(0);
	});

	it("answers a throwing store with its classified status", async () => {
		vi.spyOn(storage.keys, "getWithCredential").mockRejectedValue(new Error(STORE_DOWN));
		const response = await send();
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: { message: STORE_DOWN, type: "upstream_error" } });
		expect(mock.calls).toHaveLength(0);
	});

	it("answers 499 and takes no lease when the client leaves during credential lookup", async () => {
		const client = new AbortController();
		const started = Promise.withResolvers<void>();
		const lookup = Promise.withResolvers<ResolvedApiKey>();
		vi.spyOn(storage.keys, "getWithCredential").mockImplementation(() => {
			started.resolve();
			return lookup.promise;
		});
		const acquire = vi.spyOn(AuthGatewaySessionStateStore.prototype, "acquire");
		const pending = send(client.signal);
		await started.promise;
		client.abort();
		lookup.resolve({ apiKey: "late-key" });
		const response = await pending;
		expect(response.status).toBe(499);
		expect(await response.json()).toEqual(route.abortedBody);
		expect(acquire).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(0);
	});
});
