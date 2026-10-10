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
			if (!body.agentAccountId) {
				return Response.json({ code: "invalid_argument", message: "missing agent" }, { status: 400 });
			}
			const row = rows.get(id);
			// An id outside the agent's pool looks missing, so ids cannot be probed.
			if (!row || body.agentAccountId !== ACCOUNT_ID) {
				return Response.json({ code: "not_found", message: "missing credential" }, { status: 404 });
			}
			if (body.expectedVersion !== row.version) {
				return Response.json({ code: "aborted", message: "version changed" }, { status: 409 });
			}
			if (method === "UpdateCredentialOAuth") {
				if (!row.oauth) {
					return Response.json({ code: "failed_precondition", message: "not oauth" }, { status: 412 });
				}
				const tokenBody = record(body.token);
				const access = tokenBody?.access;
				if (typeof access !== "string" || access === "") {
					return Response.json({ code: "invalid_argument", message: "token without access" }, { status: 400 });
				}
				// The server merges: a field the client leaves empty keeps its stored value.
				const merged: Record<string, unknown> = { ...row.oauth };
				for (const [key, value] of Object.entries(tokenBody ?? {})) {
					if (value !== "" && value !== undefined && value !== 0 && value !== "0") merged[key] = value;
				}
				row.oauth = merged;
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

	test("keeps a delete through a non-Connect 503 and resends the disable", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			server.failNext("DisableCredential", () => new Response("<html>bad gateway</html>", { status: 503 }));
			expect(await store.deleteAuthCredential(1, "logout")).toBe(true);
			expect(store.listAuthCredentials()).toEqual([]);
			store.pollExternalChanges();
			await store.flush();
			expect(server.rows.has("cred/key")).toBe(false);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("a definitive disable failure still rejects", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url);
		try {
			server.failNext("DisableCredential", () => Response.json({ code: "permission_denied" }, { status: 403 }));
			await expect(store.deleteAuthCredential(1, "logout")).rejects.toMatchObject({ code: "permission_denied" });
		} finally {
			store.close();
		}
	});

	test("lands a queued write after an earlier one committed but lost its response", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			const held = server.hold("UpdateCredentialOAuth");
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-a", refresh: "refresh-a" });
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-b", refresh: "refresh-b" });
			// Commit A on the server, then lose its response.
			server.rows.set("cred/oauth", {
				...oauthRow(),
				version: "2",
				oauth: { ...oauthToken, access: "access-a", refresh: "refresh-a" },
			});
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			held.release();
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth?.refresh).toBe("refresh-b");
			expect(oauthOf(store).credential.refresh).toBe("refresh-b");
		} finally {
			store.close();
		}
	});

	test("lands a queued write after two writes in a row lost their responses", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			const held = server.hold("UpdateCredentialOAuth");
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-a", refresh: "refresh-a" });
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-b", refresh: "refresh-b" });
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-c", refresh: "refresh-c" });
			const commitThenLose = (access: string, refresh: string, version: string) => () => {
				server.rows.set("cred/oauth", { ...oauthRow(), version, oauth: { ...oauthToken, access, refresh } });
				return new Response("bad gateway", { status: 503 });
			};
			// A commits and loses its response; B adopts A, commits, and loses its response too.
			server.failNext("UpdateCredentialOAuth", commitThenLose("access-a", "refresh-a", "2"));
			held.release();
			await Bun.sleep(0);
			server.failNext("UpdateCredentialOAuth", commitThenLose("access-b", "refresh-b", "3"));
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth?.refresh).toBe("refresh-c");
			expect(oauthOf(store).credential.refresh).toBe("refresh-c");
		} finally {
			store.close();
		}
	});

	test("does not adopt a peer write that kept the access token but rotated refresh", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			const held = server.hold("UpdateCredentialOAuth");
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-a", refresh: "refresh-a" });
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-b", refresh: "refresh-b" });
			const peer = {
				...oauthRow(),
				version: "3",
				oauth: { ...oauthToken, access: "access-a", refresh: "refresh-peer" },
			};
			server.rows.set("cred/oauth", peer);
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			held.release();
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth?.refresh).toBe("refresh-peer");
			expect(oauthOf(store).credential.refresh).toBe("refresh-peer");
		} finally {
			store.close();
		}
	});

	test("a transient delete survives a later OAuth failure on the same row", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			const row = oauthOf(store);
			const held = server.hold("DisableCredential");
			const deleted = store.deleteAuthCredential(row.id, "logout");
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-late" });
			server.failNext("DisableCredential", () => new Response("bad gateway", { status: 503 }));
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			held.release();
			expect(await deleted).toBe(true);
			await store.flush();
			store.pollExternalChanges();
			await store.flush();
			expect(server.rows.has("cred/oauth")).toBe(false);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("a transient delete still lands after a peer bumps the row", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			server.failNext("DisableCredential", () => new Response("bad gateway", { status: 503 }));
			expect(await store.deleteAuthCredential(1, "logout")).toBe(true);
			server.rows.set("cred/key", { ...apiKeyRow(), version: "9" });
			store.pollExternalChanges();
			await store.flush();
			expect(server.rows.has("cred/key")).toBe(false);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("a parked delete survives a later OAuth write losing a race", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 60_000 });
		try {
			const row = oauthOf(store);
			const held = server.hold("DisableCredential");
			const deleted = store.deleteAuthCredential(row.id, "logout");
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-late" });
			server.failNext("DisableCredential", () => new Response("bad gateway", { status: 503 }));
			// The queued OAuth write then loses a CAS race to a peer.
			server.rows.set("cred/oauth", { ...oauthRow(), version: "7" });
			held.release();
			expect(await deleted).toBe(true);
			await store.flush();
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("adopts its own lost write that carried a zero expiry", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			const held = server.hold("UpdateCredentialOAuth");
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-a", expires: 0 });
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-b", refresh: "refresh-b" });
			// The server keeps the stored expiry for a zero field, then the response is lost.
			server.failNext("UpdateCredentialOAuth", () => {
				server.rows.set("cred/oauth", {
					...oauthRow(),
					version: "2",
					oauth: { ...oauthToken, access: "access-a" },
				});
				return new Response("bad gateway", { status: 503 });
			});
			held.release();
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth?.refresh).toBe("refresh-b");
		} finally {
			store.close();
		}
	});

	test("keeps a parked delete when the reload after its conflict fails", async () => {
		const server = startFakeServer([apiKeyRow()]);
		const store = await storeFor(server.url, { refreshIntervalMs: 0 });
		try {
			server.failNext("DisableCredential", () => new Response("bad gateway", { status: 503 }));
			expect(await store.deleteAuthCredential(1, "logout")).toBe(true);
			server.rows.set("cred/key", { ...apiKeyRow(), version: "9" });
			// The resend conflicts and the reload after it fails, so nothing confirms the row is gone.
			const conflict = server.hold("DisableCredential");
			store.pollExternalChanges();
			await conflict.reached;
			const down = () => new Response("bad gateway", { status: 503 });
			const relist = server.hold("ListCredentialPool");
			conflict.release();
			await relist.reached;
			server.failNext("ListCredentialPool", down);
			relist.release();
			await store.flush();
			expect(store.listAuthCredentials()).toEqual([]);
			store.pollExternalChanges();
			await store.flush();
			store.pollExternalChanges();
			await store.flush();
			expect(server.rows.has("cred/key")).toBe(false);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("a peer write after a lost response still wins", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			const held = server.hold("UpdateCredentialOAuth");
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-a" });
			await held.reached;
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-b" });
			server.rows.set("cred/oauth", {
				...oauthRow(),
				version: "3",
				oauth: { ...oauthToken, access: "access-peer" },
			});
			server.failNext("UpdateCredentialOAuth", () => new Response("bad gateway", { status: 503 }));
			held.release();
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth?.access).toBe("access-peer");
			expect(oauthOf(store).credential.access).toBe("access-peer");
		} finally {
			store.close();
		}
	});

	test("does not report its own adopted write as an external change", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const row = oauthOf(store);
			store.updateAuthCredential(row.id, { ...row.credential, access: "access-local" });
			store.acknowledgeLocalChanges();
			expect(store.pollExternalChanges()).toBe(false);
		} finally {
			auth.close();
		}
	});

	test("logout disables every row of the provider", async () => {
		const server = startFakeServer([apiKeyRow("cred/a", "sk-a"), apiKeyRow("cred/b", "sk-b"), oauthRow()]);
		const store = await storeFor(server.url);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			await auth.credentials.remove("deepseek");
			expect([...server.rows.keys()]).toEqual(["cred/oauth"]);
			expect(store.listAuthCredentials().map(row => row.provider)).toEqual(["anthropic"]);
		} finally {
			auth.close();
		}
	});

	test("sends whole-millisecond int64 timestamps", async () => {
		const server = startFakeServer([oauthRow()]);
		const store = await storeFor(server.url);
		try {
			const row = oauthOf(store);
			store.updateAuthCredential(row.id, {
				...row.credential,
				access: "access-frac",
				expires: 1750000000123.7,
				authorizedAt: 1740000000456.2,
			});
			await store.flush();
			expect(server.rows.get("cred/oauth")?.oauth).toMatchObject({
				access: "access-frac",
				expiresUnixMs: "1750000000123",
				authorizedAtUnixMs: "1740000000456",
			});
		} finally {
			store.close();
		}
	});

	test("refuses a plaintext base URL off loopback", () => {
		const opts = { token: TOKEN, agentAccountId: ACCOUNT_ID };
		expect(() => new CompassAuthCredentialStore({ ...opts, baseUrl: "http://compass.example:8443" })).toThrow(
			"must use https",
		);
		expect(() => new CompassAuthCredentialStore({ ...opts, baseUrl: "compass:8443" })).toThrow();
		expect(() => new CompassAuthCredentialStore({ ...opts, baseUrl: "https://compass.example" })).not.toThrow();
		expect(() => new CompassAuthCredentialStore({ ...opts, baseUrl: "http://127.0.0.1:9000" })).not.toThrow();
	});

	test("does not follow a redirect with the credential body", async () => {
		let landed = false;
		const elsewhere = Bun.serve({
			port: 0,
			fetch: () => {
				landed = true;
				return Response.json({ credentials: [] });
			},
		});
		const redirector = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 307, headers: { location: elsewhere.url.toString() } }),
		});
		servers.push(elsewhere, redirector);
		await expect(storeFor(redirector.url.toString())).rejects.toBeDefined();
		expect(landed).toBe(false);
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
