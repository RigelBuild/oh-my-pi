import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { AuthStorage, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import {
	CompassAuthCredentialStore,
	CompassOwnerPool,
	currentAgentToken,
	openCompassOwner,
	runWithAgentToken,
	type CompassOwnerEntry,
	type GatewayCredential,
	type GatewayOAuthToken,
} from "@oh-my-pi/pi-ai/compass";

interface FakeOwner {
	entry: CompassOwnerEntry;
	closed(): number;
	setPending(value: boolean): void;
}

interface RpcRequest {
	method: string;
	body: Record<string, unknown>;
	agentToken: string | undefined;
}

interface FakeDoor {
	url: string;
	requests: RpcRequest[];
	credential(): GatewayCredential;
	failNextUpdate(): void;
}

const SERVICE_TOKEN = "compass-owner-pool-service-token";
const OWNER_TOKEN = "compass-owner-pool-agent-token";
const LIVE_TOKEN = "compass-owner-pool-live-token";
const oauthToken: GatewayOAuthToken = {
	access: "access-before",
	refresh: "refresh-before",
	expiresUnixMs: "1750000000123",
};

const pools: CompassOwnerPool[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const pool of pools) pool.close();
	pools.length = 0;
	for (const server of servers) server.stop(true);
	servers.length = 0;
});

function pool(options: ConstructorParameters<typeof CompassOwnerPool>[0]): CompassOwnerPool {
	const value = new CompassOwnerPool({ sweepIntervalMs: 0, ...options });
	pools.push(value);
	return value;
}

function fakeOwner(): FakeOwner {
	const credentialStore = new CompassAuthCredentialStore({
		baseUrl: "http://127.0.0.1",
		token: SERVICE_TOKEN,
	});
	const storage = new AuthStorage(credentialStore, { sourceLabel: "compass" });
	let closeCount = 0;
	let pending = false;
	const close = storage.close.bind(storage);
	storage.close = () => {
		closeCount += 1;
		close();
	};
	return {
		entry: { storage, store: { hasPendingWrites: () => pending } },
		closed: () => closeCount,
		setPending: value => {
			pending = value;
		},
	};
}

function startFakeDoor(): FakeDoor {
	let row: GatewayCredential = {
		id: "credential/oauth",
		provider: "anthropic",
		scope: "GATEWAY_CREDENTIAL_SCOPE_OWN",
		version: "1",
		oauth: { ...oauthToken },
	};
	const requests: RpcRequest[] = [];
	let failUpdate = false;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const method = url.pathname.split("/").at(-1) ?? "";
			const value: unknown = await request.json();
			const body = record(value);
			if (!body) return Response.json({ code: "invalid_argument", message: "invalid body" }, { status: 400 });
			const agentToken = typeof body.agentToken === "string" ? body.agentToken : undefined;
			requests.push({ method, body, agentToken });
			if (
				request.headers.get("authorization") !== `Bearer ${SERVICE_TOKEN}` ||
				request.headers.get("connect-protocol-version") !== "1" ||
				request.headers.get("content-type") !== "application/json" ||
				url.pathname !== `/compass.v1.GatewayCredentials/${method}`
			) {
				return Response.json({ code: "unauthenticated", message: "bad request" }, { status: 401 });
			}
			if (agentToken !== OWNER_TOKEN && agentToken !== LIVE_TOKEN) {
				return Response.json({ code: "unauthenticated", message: "missing agent token" }, { status: 401 });
			}
			if (method === "ListCredentialPool") return Response.json({ credentials: [row] });
			if (method !== "UpdateCredentialOAuth") {
				return Response.json({ code: "unimplemented", message: "unknown method" }, { status: 404 });
			}
			if (failUpdate) {
				failUpdate = false;
				return Response.json({ code: "unauthenticated", message: "agent token expired" }, { status: 401 });
			}
			if (body.expectedVersion !== row.version) {
				return Response.json({ code: "aborted", message: "version changed" }, { status: 409 });
			}
			const token = record(body.token);
			if (!token || typeof token.access !== "string" || typeof token.refresh !== "string") {
				return Response.json({ code: "invalid_argument", message: "invalid token" }, { status: 400 });
			}
			const version = String(Number(row.version) + 1);
			row = { ...row, version, oauth: { ...row.oauth, ...token, expiresUnixMs: "1750000000123" } };
			return Response.json({ version });
		},
	});
	servers.push(server);
	return {
		url: server.url.toString(),
		requests,
		credential: () => row,
		failNextUpdate() {
			failUpdate = true;
		},
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return Object.fromEntries(Object.entries(value));
}

function oauthOf(store: CompassAuthCredentialStore): { id: number; credential: OAuthCredential } {
	const row = store.listAuthCredentials("anthropic")[0];
	if (!row || row.credential.type !== "oauth") throw new Error("expected OAuth credential");
	return { id: row.id, credential: row.credential };
}

describe("CompassOwnerPool", () => {
	bunTest("rejects a missing owner id", async () => {
		const ownerPool = pool({ open: async () => fakeOwner().entry });
		await expect(ownerPool.get("")).rejects.toThrow("owner id");
	});
	bunTest("keeps one storage instance per owner", async () => {
		const first = fakeOwner();
		const second = fakeOwner();
		const ownerPool = pool({ open: async owner => (owner === "a" ? first.entry : second.entry) });

		const storage = await ownerPool.get("a");
		expect(await ownerPool.get("a")).toBe(storage);
		expect(await ownerPool.get("b")).toBe(second.entry.storage);
	});

	bunTest("shares concurrent first opens for one owner", async () => {
		const owner = fakeOwner();
		const opening = Promise.withResolvers<CompassOwnerEntry>();
		let opens = 0;
		const ownerPool = pool({
			open: () => {
				opens += 1;
				return opening.promise;
			},
		});

		const first = ownerPool.get("a");
		const second = ownerPool.get("a");
		expect(opens).toBe(1);
		opening.resolve(owner.entry);
		expect(await first).toBe(owner.entry.storage);
		expect(await second).toBe(owner.entry.storage);
		expect(opens).toBe(1);
	});

	bunTest("retries a failed lazy open", async () => {
		const owner = fakeOwner();
		let opens = 0;
		const ownerPool = pool({
			open: async () => {
				opens += 1;
				if (opens === 1) throw new Error("open failed");
				return owner.entry;
			},
		});

		await expect(ownerPool.get("a")).rejects.toThrow("open failed");
		expect(await ownerPool.get("a")).toBe(owner.entry.storage);
		expect(opens).toBe(2);
	});

	bunTest("closes idle owners after the idle threshold", async () => {
		let now = 0;
		const owner = fakeOwner();
		const ownerPool = pool({ open: async () => owner.entry, idleMs: 10, now: () => now });
		await ownerPool.get("a");

		now = 11;
		ownerPool.sweep();
		expect(owner.closed()).toBe(1);
	});

	bunTest("holds a response lease through a stream and releases it on cancel", async () => {
		let now = 0;
		const first = fakeOwner();
		const second = fakeOwner();
		const ownerPool = pool({
			open: async owner => (owner === "a" ? first.entry : second.entry),
			maxOwners: 1,
			idleMs: 10,
			minIdleMs: 4,
			now: () => now,
		});
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("open"));
			},
		});
		const response = await ownerPool.withRequestLease(async () => {
			await ownerPool.get("a");
			await ownerPool.get("a");
			return new Response(body, { status: 202, headers: { "x-owner": "a" } });
		});
		expect(response.status).toBe(202);
		expect(response.headers.get("x-owner")).toBe("a");

		now = 11;
		await ownerPool.get("b");
		now = 17;
		ownerPool.sweep();
		expect(first.closed()).toBe(0);
		expect(second.closed()).toBe(1);

		await response.body?.cancel();
		ownerPool.sweep();
		expect(first.closed()).toBe(1);
	});

	bunTest("releases a response lease when its body ends or errors", async () => {
		let now = 0;
		const ended = fakeOwner();
		const errored = fakeOwner();
		const ownerPool = pool({
			open: async owner => (owner === "ended" ? ended.entry : errored.entry),
			idleMs: 10,
			now: () => now,
		});
		const endedResponse = await ownerPool.withRequestLease(async () => {
			await ownerPool.get("ended");
			return new Response("complete");
		});
		expect(await endedResponse.text()).toBe("complete");
		const errorResponse = await ownerPool.withRequestLease(async () => {
			await ownerPool.get("errored");
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error("stream failed"));
					},
				}),
			);
		});
		await expect(errorResponse.text()).rejects.toThrow("stream failed");

		now = 11;
		ownerPool.sweep();
		expect(ended.closed()).toBe(1);
		expect(errored.closed()).toBe(1);
	});

	bunTest("releases leases for bodyless responses and thrown runs", async () => {
		let now = 0;
		const bodyless = fakeOwner();
		const thrown = fakeOwner();
		const ownerPool = pool({
			open: async owner => (owner === "bodyless" ? bodyless.entry : thrown.entry),
			idleMs: 10,
			now: () => now,
		});
		const response = await ownerPool.withRequestLease(async () => {
			await ownerPool.get("bodyless");
			return new Response(null);
		});
		expect(response.body).toBeNull();
		await expect(
			ownerPool.withRequestLease(async () => {
				await ownerPool.get("thrown");
				throw new Error("route failed");
			}),
		).rejects.toThrow("route failed");

		now = 11;
		ownerPool.sweep();
		expect(bodyless.closed()).toBe(1);
		expect(thrown.closed()).toBe(1);
	});

	bunTest("evicts least-recently-used idle entries only when unleased and unpinned", async () => {
		let now = 0;
		const a = fakeOwner();
		const b = fakeOwner();
		const c = fakeOwner();
		const d = fakeOwner();
		const ownerPool = pool({
			open: async owner => ({ a: a.entry, b: b.entry, c: c.entry, d: d.entry })[owner] ?? a.entry,
			maxOwners: 2,
			idleMs: 100,
			minIdleMs: 10,
			now: () => now,
		});
		await ownerPool.get("a");
		now = 5;
		await ownerPool.get("b");
		now = 10;
		await ownerPool.get("c");
		a.setPending(true);
		now = 30;
		ownerPool.sweep();
		expect(a.closed()).toBe(0);
		expect(b.closed()).toBe(1);
		expect(c.closed()).toBe(0);

		a.setPending(false);
		now = 31;
		await ownerPool.get("a");
		now = 32;
		await ownerPool.get("d");
		now = 50;
		ownerPool.sweep();
		expect(a.closed()).toBe(0);
		expect(c.closed()).toBe(1);
		expect(d.closed()).toBe(0);
	});

	bunTest("preserves an idle parked write until a scoped pool request commits it", async () => {
		const door = startFakeDoor();
		let now = 0;
		let store: CompassAuthCredentialStore | undefined;
		const otherOwners = [fakeOwner(), fakeOwner(), fakeOwner()];
		const ownerPool = pool({
			open: async owner => {
				if (owner !== "owner-a") {
					const index = Number(owner.slice(-1));
					const other = otherOwners[index];
					if (!other) throw new Error("unexpected test owner");
					return other.entry;
				}
				store = await CompassAuthCredentialStore.open({
					baseUrl: door.url,
					token: SERVICE_TOKEN,
					refreshIntervalMs: 0,
				});
				const storage = new AuthStorage(store, { sourceLabel: "compass" });
				await storage.credentials.reload();
				return { storage, store };
			},
			maxOwners: 1,
			idleMs: 10,
			minIdleMs: 4,
			now: () => now,
		});
		let storage: AuthStorage | undefined;
		await runWithAgentToken(OWNER_TOKEN, () =>
			ownerPool.withRequestLease(async () => {
				storage = await ownerPool.get("owner-a");
			}),
		);
		const openedStore = store;
		if (!openedStore || !storage) throw new Error("owner did not open");
		const oauth = oauthOf(openedStore);
		door.failNextUpdate();
		runWithAgentToken(OWNER_TOKEN, () =>
			openedStore.updateAuthCredential(oauth.id, {
				...oauth.credential,
				access: "access-parked",
				refresh: "refresh-parked",
			}),
		);
		await openedStore.flush();
		expect(openedStore.hasPendingWrites()).toBe(true);

		now = 5;
		await ownerPool.get("other-0");
		now = 10;
		await ownerPool.get("other-1");
		now = 15;
		await ownerPool.get("other-2");
		now = 26;
		ownerPool.sweep();
		expect(openedStore.hasPendingWrites()).toBe(true);
		await runWithAgentToken(LIVE_TOKEN, () =>
			ownerPool.withRequestLease(async () => {
				const current = await ownerPool.get("owner-a");
				await current.credentials.poll();
			}),
		);
		await openedStore.flush();
		expect(door.credential().oauth?.access).toBe("access-parked");
		expect(
			door.requests.filter(request => request.method === "UpdateCredentialOAuth").map(request => request.agentToken),
		).toEqual([OWNER_TOKEN, LIVE_TOKEN]);
		expect(openedStore.hasPendingWrites()).toBe(false);
	});

	bunTest("opens Compass storage and reloads credentials before returning", async () => {
		const door = startFakeDoor();
		const entry = await runWithAgentToken(OWNER_TOKEN, () =>
			openCompassOwner({
				baseUrl: door.url,
				token: SERVICE_TOKEN,
				refreshIntervalMs: 0,
			}),
		);
		try {
			expect(entry.storage.credentials.has("anthropic")).toBe(true);
			expect(door.requests.map(request => request.method)).toEqual(["ListCredentialPool"]);
		} finally {
			entry.storage.close();
		}
	});

	bunTest("closes every owner on pool shutdown", async () => {
		const first = fakeOwner();
		const second = fakeOwner();
		second.setPending(true);
		const ownerPool = pool({ open: async owner => (owner === "a" ? first.entry : second.entry) });
		const response = await ownerPool.withRequestLease(async () => {
			await ownerPool.get("a");
			return new Response(new ReadableStream<Uint8Array>());
		});
		await ownerPool.get("b");

		ownerPool.close();
		expect(first.closed()).toBe(1);
		expect(second.closed()).toBe(1);
		await response.body?.cancel();
		await expect(ownerPool.get("a")).rejects.toThrow();
		expect(currentAgentToken()).toBeUndefined();
	});
});
