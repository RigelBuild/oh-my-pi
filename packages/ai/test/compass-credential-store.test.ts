import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { CompassAuthCredentialStore, type GatewayCredential, type GatewayOAuthToken } from "@oh-my-pi/pi-ai/compass";

interface FakeRow extends GatewayCredential {
	version: string;
}

interface RpcRequest {
	method: string;
	body: Record<string, unknown>;
}

interface FakeServer {
	rows: Map<string, FakeRow>;
	requests: RpcRequest[];
	url: string;
	/** Pauses the next call of a method after it is recorded but before the server reads or writes rows. */
	hold(method: string): { reached: Promise<void>; release: () => void };
	/** Makes the next call of a method answer with this raw response. */
	failNext(method: string, response: () => Response): void;
}

const TOKEN = "compass-test-token";
const ACCOUNT_ID = "agent-account-1";
const oauthToken: GatewayOAuthToken = {
	access: "access-original",
	refresh: "refresh-original",
	expiresUnixMs: "1750000000123",
	enterpriseUrl: "https://enterprise.example",
	projectId: "project-1",
	email: "agent@example.com",
	accountId: "account-1",
	apiEndpoint: "https://api.example",
	orgId: "org-1",
	orgName: "Example Org",
	authorizedAtUnixMs: "1740000000456",
	region: "eu",
	inferenceRegion: "eu",
	activeOrganizationId: "org-active",
};

let servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers) server.stop(true);
	servers = [];
});

function record(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return Object.fromEntries(Object.entries(value));
}

function startFakeServer(initialRows: FakeRow[]): FakeServer {
	const rows = new Map(initialRows.map(row => [row.id, { ...row }]));
	const requests: RpcRequest[] = [];
	const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
	const failures = new Map<string, () => Response>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const method = url.pathname.split("/").at(-1) ?? "";
			const body = record(await request.json());
			if (!body) return Response.json({ code: "invalid_argument", message: "invalid body" }, { status: 400 });
			requests.push({ method, body });
			const hold = holds.get(method);
			if (hold) {
				holds.delete(method);
				hold.reached();
				await hold.released;
			}
			const failure = failures.get(method);
			if (failure) {
				failures.delete(method);
				return failure();
			}
			if (
				request.headers.get("authorization") !== `Bearer ${TOKEN}` ||
				request.headers.get("connect-protocol-version") !== "1" ||
				request.headers.get("content-type") !== "application/json"
			) {
				return Response.json({ code: "unauthenticated", message: "bad request" }, { status: 401 });
			}
			if (url.pathname !== `/compass.v1.GatewayCredentials/${method}`) {
				return Response.json({ code: "not_found", message: "unknown method" }, { status: 404 });
			}
			if (method === "ListCredentialPool") {
				if (body.agentAccountId !== ACCOUNT_ID) {
					return Response.json({ code: "not_found", message: "unknown agent" }, { status: 404 });
				}
				return Response.json({ credentials: [...rows.values()] });
			}
			const id = typeof body.id === "string" ? body.id : "";
			const row = rows.get(id);
			if (!row) return Response.json({ code: "not_found", message: "missing credential" }, { status: 404 });
			if (body.expectedVersion !== row.version) {
				return Response.json({ code: "aborted", message: "version changed" }, { status: 409 });
			}
			if (method === "UpdateCredentialOAuth") {
				if (!row.oauth) {
					return Response.json({ code: "failed_precondition", message: "not oauth" }, { status: 412 });
				}
				const tokenBody = record(body.token);
				const access = tokenBody?.access;
				const refresh = tokenBody?.refresh;
				const expiresUnixMs = tokenBody?.expiresUnixMs;
				if (
					typeof access !== "string" ||
					typeof refresh !== "string" ||
					(typeof expiresUnixMs !== "string" && typeof expiresUnixMs !== "number")
				) {
					return Response.json({ code: "invalid_argument", message: "invalid token" }, { status: 400 });
				}
				row.oauth = { ...tokenBody, access, refresh, expiresUnixMs };
				row.version = String(Number(row.version) + 1);
				return Response.json({ version: row.version });
			}
			if (method === "DisableCredential") {
				rows.delete(id);
				return Response.json({});
			}
			return Response.json({ code: "not_found", message: "unknown method" }, { status: 404 });
		},
	});
	servers.push(server);
	return {
		rows,
		requests,
		url: server.url.toString(),
		hold(method) {
			const reached = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			holds.set(method, { reached: reached.resolve, released: released.promise });
			return { reached: reached.promise, release: released.resolve };
		},
		failNext(method, response) {
			failures.set(method, response);
		},
	};
}

function storeFor(url: string, opts: { refreshIntervalMs?: number } = {}): Promise<CompassAuthCredentialStore> {
	return CompassAuthCredentialStore.open({
		baseUrl: url,
		token: TOKEN,
		agentAccountId: ACCOUNT_ID,
		refreshIntervalMs: opts.refreshIntervalMs ?? 60_000,
	});
}

function methods(server: FakeServer): string[] {
	return server.requests.map(request => request.method);
}

function oauthOf(store: CompassAuthCredentialStore): { id: number; data: string; credential: OAuthCredential } {
	const row = store.listAuthCredentials("anthropic")[0];
	if (!row || row.credential.type !== "oauth") throw new Error("expected OAuth row");
	return { id: row.id, data: JSON.stringify(withoutType(row.credential)), credential: row.credential };
}

function oauthRow(id = "cred/oauth"): FakeRow {
	return {
		id,
		provider: "anthropic",
		scope: "GATEWAY_CREDENTIAL_SCOPE_SHARED",
		version: "1",
		oauth: { ...oauthToken },
	};
}

function apiKeyRow(id = "cred/key", key = "sk-compass-key"): FakeRow {
	return {
		id,
		provider: "deepseek",
		scope: "GATEWAY_CREDENTIAL_SCOPE_OWN",
		version: "3",
		apiKey: key,
	};
}

function withoutType(credential: OAuthCredential): Omit<OAuthCredential, "type"> {
	const { type: _type, ...fields } = credential;
	return fields;
}

describe("CompassAuthCredentialStore", () => {
	test("maps OAuth int64 strings and API keys while ignoring scope", async () => {
		const server = startFakeServer([
			oauthRow(),
			{
				...oauthRow("cred/empty-optionals"),
				oauth: { access: "a", refresh: "r", expiresUnixMs: 0, enterpriseUrl: "", authorizedAtUnixMs: 0 },
			},
			apiKeyRow(),
		]);
		const store = await storeFor(server.url);
		try {
			const rows = store.listAuthCredentials();
			const oauth = rows[0]?.credential;
			if (oauth?.type !== "oauth") throw new Error("expected OAuth credential");
			expect(oauth).toEqual({
				type: "oauth",
				access: "access-original",
				refresh: "refresh-original",
				expires: 1_750_000_000_123,
				enterpriseUrl: "https://enterprise.example",
				projectId: "project-1",
				email: "agent@example.com",
				accountId: "account-1",
				apiEndpoint: "https://api.example",
				orgId: "org-1",
				orgName: "Example Org",
				authorizedAt: 1_740_000_000_456,
				region: "eu",
				inferenceRegion: "eu",
				activeOrganizationId: "org-active",
			});
			const emptyOAuth = rows[1]?.credential;
			if (emptyOAuth?.type !== "oauth") throw new Error("expected empty OAuth credential");
			expect(emptyOAuth.enterpriseUrl).toBeUndefined();
			expect(emptyOAuth.authorizedAt).toBeUndefined();
			expect(rows[2]?.credential).toEqual({ type: "api_key", key: "sk-compass-key", source: "login" });
			expect(rows.map(row => row.id)).toEqual([1, 2, 3]);
			expect(server.requests[0]).toMatchObject({
				method: "ListCredentialPool",
				body: { agentAccountId: ACCOUNT_ID },
			});
		} finally {
			store.close();
		}
	});

	test("polls one time for a server-side credential change", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url);
		try {
			expect(store.pollExternalChanges()).toBe(false);
			server.rows.set("cred/key", { ...apiKeyRow("cred/key", "sk-updated"), version: "4" });
			await store.refreshSnapshot();
			expect(store.pollExternalChanges()).toBe(true);
			expect(store.pollExternalChanges()).toBe(false);
		} finally {
			store.close();
		}
	});

	test("decodes rows carrying fields a newer server added", async () => {
		const server = startFakeServer([
			{ ...oauthRow(), oauth: { ...oauthToken, futureField: "x" } as GatewayOAuthToken },
		]);
		const store = await storeFor(server.url);
		try {
			expect(store.listAuthCredentials("anthropic")).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("writes every OAuth field back so a refresh keeps the account's region", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-refreshed" });
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth).toEqual({ ...oauthToken, access: "access-refreshed" });
		} finally {
			store.close();
		}
	});

	test("serializes back-to-back OAuth compare-and-swap updates", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = store.listAuthCredentials("anthropic")[0];
			if (!row || row.credential.type !== "oauth") throw new Error("expected OAuth row");
			const first = { ...row.credential, access: "access-first" };
			const second = { ...row.credential, access: "access-second" };
			expect(
				store.tryUpdateAuthCredentialIfMatches(row.id, JSON.stringify(withoutType(row.credential)), first),
			).toBe(true);
			store.updateAuthCredential(row.id, second);
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth?.access).toBe("access-second");
			expect(server.rows.get("cred/oauth")?.version).toBe("3");
			const writes = server.requests.filter(request => request.method === "UpdateCredentialOAuth");
			expect(writes).toHaveLength(2);
			expect(writes.map(request => request.body.expectedVersion)).toEqual(["1", "2"]);
		} finally {
			store.close();
		}
	});

	test("reloads the authoritative row after a lost compare-and-swap race", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = store.listAuthCredentials()[0];
			if (!row || row.credential.type !== "oauth") throw new Error("expected OAuth row");
			server.rows.set("cred/oauth", {
				...oauthRow(),
				version: "2",
				oauth: { ...oauthToken, access: "access-out-of-band" },
			});
			expect(
				store.tryUpdateAuthCredentialIfMatches(row.id, JSON.stringify(withoutType(row.credential)), {
					...row.credential,
					access: "access-local",
				}),
			).toBe(true);
			await store.flush();
			expect(store.listAuthCredentials()[0]?.credential).toMatchObject({
				type: "oauth",
				access: "access-out-of-band",
			});
			expect(server.requests.filter(request => request.method === "ListCredentialPool")).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	test("does not send a disable when the stored data does not match", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = store.listAuthCredentials()[0];
			if (!row || row.credential.type !== "oauth") throw new Error("expected OAuth row");
			expect(store.tryDisableAuthCredentialIfMatches(row.id, "stale-data", "invalid_grant")).toBe(false);
			expect(server.requests.map(request => request.method)).toEqual(["ListCredentialPool"]);
		} finally {
			store.close();
		}
	});

	test("returns false when delete reports not_found", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url);
		try {
			server.rows.delete("cred/key");
			expect(await store.deleteAuthCredential(1, "logout")).toBe(false);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("rejects enrollment writes through Compass", async () => {
		const server = startFakeServer([]);
		const store = await storeFor(server.url);
		try {
			await expect(
				store.upsertAuthCredential("deepseek", { type: "api_key", key: "sk", source: "login" }),
			).rejects.toThrow("enrolled through Compass");
			await expect(store.replaceAuthCredentials("deepseek", [])).rejects.toThrow("enrolled through Compass");
			await expect(store.deleteAuthCredentials("deepseek", "logout")).rejects.toThrow("enrolled through Compass");
		} finally {
			store.close();
		}
	});

	test("resolves a login API key through AuthStorage", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			expect(await auth.keys.get("deepseek", "compass-test-session")).toBe("sk-compass-key");
		} finally {
			auth.close();
		}
	});

	describe("write ordering under races", () => {
		const peerRow = (): FakeRow => ({ ...oauthRow(), version: "2", oauth: { ...oauthToken, access: "access-peer" } });

		test("drops a queued update after its predecessor loses the race", async () => {
			const server = startFakeServer([oauthRow()]);
			const store = await storeFor(server.url);
			try {
				const row = oauthOf(store);
				const held = server.hold("UpdateCredentialOAuth");
				const first = { ...row.credential, access: "access-first" };
				expect(store.tryUpdateAuthCredentialIfMatches(row.id, row.data, first)).toBe(true);
				await held.reached;
				server.rows.set("cred/oauth", peerRow());
				const second = { ...first, access: "access-second" };
				expect(store.tryUpdateAuthCredentialIfMatches(row.id, oauthOf(store).data, second)).toBe(true);
				held.release();
				await store.flush();
				expect(server.rows.get("cred/oauth")?.oauth?.access).toBe("access-peer");
				expect(methods(server).filter(method => method === "UpdateCredentialOAuth")).toHaveLength(1);
				expect(oauthOf(store).credential.access).toBe("access-peer");
			} finally {
				store.close();
			}
		});

		test("drops a queued disable after its predecessor loses the race", async () => {
			const server = startFakeServer([oauthRow()]);
			const store = await storeFor(server.url);
			try {
				const row = oauthOf(store);
				const held = server.hold("UpdateCredentialOAuth");
				const refreshed = { ...row.credential, access: "access-refreshed" };
				expect(store.tryUpdateAuthCredentialIfMatches(row.id, row.data, refreshed)).toBe(true);
				await held.reached;
				expect(store.tryDisableAuthCredentialIfMatches(row.id, oauthOf(store).data, "invalid_grant")).toBe(true);
				server.rows.set("cred/oauth", peerRow());
				held.release();
				await store.flush();
				expect(methods(server)).not.toContain("DisableCredential");
				expect(server.rows.get("cred/oauth")?.oauth?.access).toBe("access-peer");
				expect(oauthOf(store).credential.access).toBe("access-peer");
			} finally {
				store.close();
			}
		});

		test("keeps a committed write when an older list lands after it", async () => {
			const server = startFakeServer([oauthRow()]);
			const store = await storeFor(server.url);
			try {
				const row = oauthOf(store);
				const held = server.hold("ListCredentialPool");
				const staleList = store.refreshSnapshot();
				await held.reached;
				const snapshot = { ...server.rows.get("cred/oauth")! };
				expect(
					store.tryUpdateAuthCredentialIfMatches(row.id, row.data, { ...row.credential, access: "access-v2" }),
				).toBe(true);
				await store.flush();
				// Replay the pre-write rows so the held list answers with v1.
				const committed = server.rows.get("cred/oauth")!;
				server.rows.set("cred/oauth", snapshot);
				held.release();
				await staleList;
				server.rows.set("cred/oauth", committed);
				expect(oauthOf(store).credential.access).toBe("access-v2");
				const next = oauthOf(store);
				store.updateAuthCredential(next.id, { ...next.credential, access: "access-v3" });
				await store.flush();
				const writes = server.requests.filter(request => request.method === "UpdateCredentialOAuth");
				expect(writes.map(request => request.body.expectedVersion)).toEqual(["1", "2"]);
			} finally {
				store.close();
			}
		});

		test("does not resurrect a row disabled while a list was in flight", async () => {
			const server = startFakeServer([apiKeyRow()]);
			const store = await storeFor(server.url);
			try {
				const held = server.hold("ListCredentialPool");
				const staleList = store.refreshSnapshot();
				await held.reached;
				const snapshot = { ...server.rows.get("cred/key")! };
				expect(await store.deleteAuthCredential(1, "logout")).toBe(true);
				server.rows.set("cred/key", snapshot);
				held.release();
				await staleList;
				expect(store.listAuthCredentials()).toEqual([]);
			} finally {
				store.close();
			}
		});
	});

	test("polling reloads the pool in the background", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			server.rows.set("cred/key", { ...apiKeyRow("cred/key", "sk-rotated"), version: "4" });
			expect(store.pollExternalChanges()).toBe(false);
			await store.flush();
			expect(store.pollExternalChanges()).toBe(true);
			expect(store.listAuthCredentials()[0]?.credential).toMatchObject({ key: "sk-rotated" });
		} finally {
			store.close();
		}
	});

	test("maps a non-Connect 503 body to unavailable", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url);
		try {
			server.failNext("DisableCredential", () => new Response("<html>bad gateway</html>", { status: 503 }));
			await expect(store.deleteAuthCredential(1, "logout")).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			store.close();
		}
	});

	test("sends nothing after close interrupts a write", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		const row = oauthOf(store);
		const held = server.hold("UpdateCredentialOAuth");
		store.updateAuthCredential(row.id, { ...row.credential, access: "access-a" });
		await held.reached;
		store.updateAuthCredential(row.id, { ...row.credential, access: "access-b" });
		store.close();
		held.release();
		await store.flush();
		expect(methods(server)).toEqual(["ListCredentialPool", "UpdateCredentialOAuth"]);
	});

	test("keeps a minted token through a transient write failure and resends it", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			const row = oauthOf(store);
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			store.updateAuthCredential(row.id, { ...row.credential, refresh: "refresh-minted" });
			await store.flush();
			store.pollExternalChanges();
			await store.flush();
			expect(oauthOf(store).credential.refresh).toBe("refresh-minted");
			expect(server.rows.get("cred/oauth")?.oauth?.refresh).toBe("refresh-minted");
			// Once the resend lands, later polls send nothing more.
			store.pollExternalChanges();
			await store.flush();
			expect(methods(server).filter(method => method === "UpdateCredentialOAuth")).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	test("never resends an older token after a newer one landed", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			const row = oauthOf(store);
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			store.updateAuthCredential(row.id, { ...row.credential, refresh: "refresh-r1" });
			store.updateAuthCredential(row.id, { ...row.credential, refresh: "refresh-r2" });
			await store.flush();
			for (let poll = 0; poll < 2; poll++) {
				store.pollExternalChanges();
				await store.flush();
			}
			expect(server.rows.get("cred/oauth")?.oauth?.refresh).toBe("refresh-r2");
			expect(oauthOf(store).credential.refresh).toBe("refresh-r2");
		} finally {
			store.close();
		}
	});

	test("a resend that fails definitively lets the next list reconcile the row", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			const row = oauthOf(store);
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			store.updateAuthCredential(row.id, { ...row.credential, refresh: "refresh-local" });
			await store.flush();
			const denied = () => Response.json({ code: "permission_denied", message: "denied" }, { status: 403 });
			server.rows.delete("cred/oauth");
			// The error persists, so only releasing the row lets a list reconcile it.
			for (let poll = 0; poll < 2; poll++) {
				server.failNext("UpdateCredentialOAuth", denied);
				store.pollExternalChanges();
				await store.flush();
			}
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("ignores a list that lands after a newer one", async () => {
		const server = startFakeServer([apiKeyRow("cred/a", "sk-a"), apiKeyRow("cred/b", "sk-b")]);
		const store = await storeFor(server.url);
		try {
			const held = server.hold("ListCredentialPool");
			const older = store.refreshSnapshot();
			await held.reached;
			const both = new Map(server.rows);
			server.rows.delete("cred/b");
			await store.refreshSnapshot();
			for (const [id, row] of both) server.rows.set(id, row);
			held.release();
			await older;
			expect(store.listAuthCredentials().map(row => row.credential)).toEqual([
				{ type: "api_key", key: "sk-a", source: "login" },
			]);
		} finally {
			store.close();
		}
	});

	test("a user delete lands even after a peer bumped the row", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url);
		try {
			server.rows.set("cred/key", { ...apiKeyRow(), version: "4" });
			expect(await store.deleteAuthCredential(1, "deleted by user")).toBe(true);
			expect(server.rows.has("cred/key")).toBe(false);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});
});
