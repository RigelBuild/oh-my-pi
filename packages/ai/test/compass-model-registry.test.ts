import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	createStableNameResolver,
	type StableNameEntry,
	type StableNameRegistry,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import type { AgentCaller, CallerIdentity } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { CompassModelRegistry, CompassRpcError, type CompassModelRegistryOptions } from "@oh-my-pi/pi-ai/compass";
import type { GetGatewayModelRegistryResponse } from "@oh-my-pi/pi-ai/compass/wire";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { withEnv } from "./helpers";

const STABLE_NAME = "claude-opus-4-8";
const VERSION_PATH = "/compass.v1.GatewayRegistry/GetGatewayModelRegistryVersion";
const REGISTRY_PATH = "/compass.v1.GatewayRegistry/GetGatewayModelRegistry";
// hasUsable counts an env key as usable, which would decide candidate choice on a host that sets one.
const NO_PROVIDER_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
	OPENROUTER_API_KEY: undefined,
};

afterEach(() => clearCustomApis());

const candidates = [
	{ provider: "anthropic", modelId: "claude-opus-candidate" },
	{ provider: "openrouter", modelId: "anthropic/claude-opus-candidate" },
];

interface FakeRegistryServer {
	fetch: FetchImpl;
	requests: string[];
	setResponse(version: string | number | undefined, response: GetGatewayModelRegistryResponse): void;
	failNext(pathname: string): void;
	holdNext(pathname: string): { release(): void };
}

function fakeRegistryServer(initial: GetGatewayModelRegistryResponse): FakeRegistryServer {
	let version = initial.version;
	let response = initial;
	const requests: string[] = [];
	const failedPaths = new Set<string>();
	const held = new Map<string, Promise<void>>();
	const fetcher: FetchImpl = async input => {
		const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
		requests.push(pathname);
		const gate = held.get(pathname);
		if (gate) {
			held.delete(pathname);
			await gate;
		}
		if (failedPaths.delete(pathname)) return Response.json({ code: "unavailable" }, { status: 503 });
		if (pathname === VERSION_PATH) return Response.json({ version });
		if (pathname === REGISTRY_PATH) return Response.json(response);
		return Response.json({ code: "not_found" }, { status: 404 });
	};
	return {
		fetch: fetcher,
		requests,
		setResponse(nextVersion, nextResponse) {
			version = nextVersion;
			response = nextResponse;
		},
		failNext(pathname) {
			failedPaths.add(pathname);
		},
		holdNext(pathname) {
			const { promise, resolve } = Promise.withResolvers<void>();
			held.set(pathname, promise);
			return { release: () => resolve() };
		},
	};
}

function registryOptions(server: FakeRegistryServer, now: () => number = () => 0): CompassModelRegistryOptions {
	return { baseUrl: "https://compass.example", token: "registry-token", fetch: server.fetch, now };
}

function staticRegistry(entries: Record<string, StableNameEntry> | undefined): StableNameRegistry {
	const map = entries === undefined ? undefined : new Map(Object.entries(entries));
	return {
		current: async () => {
			if (!map) throw new Error("registry unavailable");
			return map;
		},
		held: () => map,
	};
}

function agent(ownerUserId?: string): AgentCaller {
	return { kind: "agent", agentAccountId: "agent-1", ownerUserId };
}

function catalog(...models: Model<Api>[]): (provider: string, modelId: string) => Model<Api> | undefined {
	const byKey = new Map(models.map(model => [`${model.provider}/${model.id}`, model]));
	return (provider, modelId) => byKey.get(`${provider}/${modelId}`);
}

async function memoryStorage(...providers: string[]): Promise<AuthStorage> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	for (const provider of providers) storage.keys.setRuntime(provider, `${provider}-key`);
	return storage;
}

test("each caller gets the first candidate its own pool can serve", async () => {
	await withEnv(NO_PROVIDER_ENV, async () => {
		const anthropic = createMockModel({ provider: "anthropic", id: candidates[0].modelId });
		const openrouter = createMockModel({ provider: "openrouter", id: candidates[1].modelId });
		const subscription = await memoryStorage("anthropic");
		const openrouterOnly = await memoryStorage("openrouter");
		try {
			const resolver = createStableNameResolver({
				registry: staticRegistry({ [STABLE_NAME]: { candidates } }),
				resolveStorage: caller => (caller.ownerUserId === "subscriber" ? subscription : openrouterOnly),
				lookupModel: catalog(anthropic.model, openrouter.model),
				fallback: () => undefined,
			});
			expect(await resolver.resolveModel(STABLE_NAME, agent("subscriber"))).toBe(anthropic.model);
			expect(await resolver.resolveModel(STABLE_NAME, agent("openrouter-user"))).toBe(openrouter.model);
		} finally {
			subscription.close();
			openrouterOnly.close();
		}
	});
});

test("an agent without an owner resolves through its own pool", async () => {
	await withEnv(NO_PROVIDER_ENV, async () => {
		const openrouter = createMockModel({ provider: "openrouter", id: candidates[1].modelId });
		const storage = await memoryStorage("openrouter");
		const seen: AgentCaller[] = [];
		try {
			const resolver = createStableNameResolver({
				registry: staticRegistry({ [STABLE_NAME]: { candidates } }),
				resolveStorage: caller => {
					seen.push(caller);
					return storage;
				},
				lookupModel: catalog(openrouter.model),
				fallback: () => undefined,
			});
			expect(await resolver.resolveModel(STABLE_NAME, agent())).toBe(openrouter.model);
			expect(seen).toEqual([agent()]);
		} finally {
			storage.close();
		}
	});
});

test("unknown names fall back, and an enroll caller gets no stable name", async () => {
	const fallback = createMockModel({ provider: "mock", id: "fallback" });
	const fallbackCalls: string[] = [];
	const resolver = createStableNameResolver({
		registry: staticRegistry({ [STABLE_NAME]: { candidates } }),
		resolveStorage: () => {
			throw new Error("enroll callers must not reach a credential pool");
		},
		lookupModel: catalog(),
		fallback: (modelId: string, _caller: CallerIdentity) => {
			fallbackCalls.push(modelId);
			return fallback.model;
		},
	});
	expect(await resolver.resolveModel("anthropic/claude-x", agent("owner"))).toBe(fallback.model);
	expect(fallbackCalls).toEqual(["anthropic/claude-x"]);
	expect(await resolver.resolveModel(STABLE_NAME, { kind: "enroll" })).toBeUndefined();
});

test("a registry outage still resolves ids the registry does not own", async () => {
	const fallback = createMockModel({ provider: "anthropic", id: "claude-x" });
	const resolver = createStableNameResolver({
		registry: staticRegistry(undefined),
		resolveStorage: () => {
			throw new Error("unused");
		},
		lookupModel: catalog(),
		fallback: () => fallback.model,
	});
	expect(await resolver.resolveModel("anthropic/claude-x", agent("owner"))).toBe(fallback.model);
	expect([...resolver.listAliases()]).toEqual([]);
});

test("with no usable candidate the first known one is returned", async () => {
	await withEnv(NO_PROVIDER_ENV, async () => {
		const anthropic = createMockModel({ provider: "anthropic", id: candidates[0].modelId });
		const openrouter = createMockModel({ provider: "openrouter", id: candidates[1].modelId });
		const storage = await memoryStorage();
		try {
			const resolver = createStableNameResolver({
				registry: staticRegistry({
					[STABLE_NAME]: { candidates: [{ provider: "missing", modelId: "gone" }, ...candidates] },
				}),
				resolveStorage: () => storage,
				lookupModel: catalog(anthropic.model, openrouter.model),
				fallback: () => undefined,
			});
			expect(await resolver.resolveModel(STABLE_NAME, agent("owner"))).toBe(anthropic.model);
		} finally {
			storage.close();
		}
	});
});

test("aliases carry the primary candidate with registry metadata", () => {
	const primary = createMockModel({
		provider: "anthropic",
		id: candidates[0].modelId,
		contextWindow: 200_000,
		cost: { input: 1, output: 3, cacheRead: 4, cacheWrite: 5 },
	});
	const resolver = createStableNameResolver({
		registry: staticRegistry({
			[STABLE_NAME]: { displayName: "Claude Opus Stable", candidates, contextWindow: 128_000, inputCost: 2.5 },
			unknownPrimary: { candidates: [{ provider: "missing", modelId: "unknown" }, candidates[0]] },
		}),
		resolveStorage: () => {
			throw new Error("unused");
		},
		lookupModel: catalog(primary.model),
		fallback: () => undefined,
	});
	const aliases = [...resolver.listAliases()];
	expect(aliases.map(alias => alias.id)).toEqual([STABLE_NAME]);
	expect(aliases[0].model).toMatchObject({
		name: "Claude Opus Stable",
		contextWindow: 128_000,
		cost: { input: 2.5, output: 3, cacheRead: 4, cacheWrite: 5 },
	});
});

test("the Compass registry converts metadata and drops entries without candidates", async () => {
	const server = fakeRegistryServer({
		version: "1",
		registry: {
			entries: {
				[STABLE_NAME]: {
					displayName: "Opus",
					candidates,
					metadata: { contextWindow: "128000", inputCostMicroUsd: 2_500_000, outputCostMicroUsd: 0 },
				},
				empty: { candidates: [] },
			},
		},
	});
	const registry = new CompassModelRegistry(registryOptions(server));
	const entries = await registry.current();
	expect([...entries.keys()]).toEqual([STABLE_NAME]);
	expect(entries.get(STABLE_NAME)).toEqual({
		displayName: "Opus",
		candidates,
		contextWindow: 128_000,
		inputCost: 2.5,
		outputCost: undefined,
	});
	expect(registry.version).toBe(1n);
});

test("a warm registry answers at once and re-reads only on a version change", async () => {
	let now = 0;
	const server = fakeRegistryServer({ version: "1", registry: { entries: { [STABLE_NAME]: { candidates } } } });
	const registry = new CompassModelRegistry(registryOptions(server, () => now));
	const first = await registry.current();
	now = 4_999;
	expect(await registry.current()).toBe(first);
	expect(server.requests).toEqual([VERSION_PATH, REGISTRY_PATH]);

	// Past the interval the read is served at once while an unchanged version is re-checked behind it.
	now = 5_000;
	const gate = server.holdNext(VERSION_PATH);
	expect(await registry.current()).toBe(first);
	gate.release();
	await registry.settled();
	expect(server.requests).toEqual([VERSION_PATH, REGISTRY_PATH, VERSION_PATH]);

	server.setResponse("2", { version: "2", registry: { entries: { renamed: { candidates } } } });
	now = 20_000;
	registry.held();
	await registry.settled();
	expect(registry.version).toBe(2n);
	expect([...(registry.held() ?? new Map()).keys()]).toEqual(["renamed"]);
	expect(server.requests).toEqual([VERSION_PATH, REGISTRY_PATH, VERSION_PATH, VERSION_PATH, REGISTRY_PATH]);
});

test("a failed re-check keeps the held registry; a cold failure throws", async () => {
	let now = 0;
	const server = fakeRegistryServer({ version: "1", registry: { entries: { [STABLE_NAME]: { candidates } } } });
	const registry = new CompassModelRegistry(registryOptions(server, () => now));
	const first = await registry.current();
	server.setResponse("2", { version: "2", registry: { entries: {} } });
	server.failNext(REGISTRY_PATH);
	now = 5_000;
	registry.held();
	await registry.settled();
	expect(await registry.current()).toBe(first);
	expect(registry.version).toBe(1n);

	const cold = fakeRegistryServer({ version: "1", registry: { entries: {} } });
	cold.failNext(VERSION_PATH);
	const coldRegistry = new CompassModelRegistry(registryOptions(cold));
	const error = await coldRegistry.current().catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(CompassRpcError);
	expect(error instanceof CompassRpcError ? error.code : undefined).toBe("unavailable");
	// Inside the interval a cold registry answers from its last failure without asking Compass again.
	await expect(coldRegistry.current()).rejects.toBe(error);
	expect(cold.requests).toEqual([VERSION_PATH]);
});

test("concurrent cold reads share one load", async () => {
	const server = fakeRegistryServer({ version: "1", registry: { entries: { [STABLE_NAME]: { candidates } } } });
	const registry = new CompassModelRegistry(registryOptions(server));
	const [first, second] = await Promise.all([registry.current(), registry.current()]);
	expect(first).toBe(second);
	expect(server.requests).toEqual([VERSION_PATH, REGISTRY_PATH]);
});

test("a JSON-number version past 2^53 is refused rather than aliased", async () => {
	const server = fakeRegistryServer({ version: 2 ** 53 + 2, registry: { entries: {} } });
	const registry = new CompassModelRegistry(registryOptions(server));
	const error = await registry.current().catch((caught: unknown) => caught);
	expect(error instanceof CompassRpcError ? error.code : undefined).toBe("invalid_response");
});

test("an RPC past its deadline fails as deadline_exceeded", async () => {
	const registry = new CompassModelRegistry({
		baseUrl: "https://compass.example",
		token: "registry-token",
		timeoutMs: 1,
		fetch: (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			}),
	});
	const error = await registry.current().catch((caught: unknown) => caught);
	expect(error instanceof CompassRpcError ? error.code : undefined).toBe("deadline_exceeded");
});

test("listing a cold registry starts its load so the next listing shows the aliases", async () => {
	const anthropic = createMockModel({ provider: "anthropic", id: candidates[0].modelId });
	const server = fakeRegistryServer({ version: "1", registry: { entries: { [STABLE_NAME]: { candidates } } } });
	const registry = new CompassModelRegistry(registryOptions(server));
	const resolver = createStableNameResolver({
		registry,
		resolveStorage: () => {
			throw new Error("unused");
		},
		lookupModel: catalog(anthropic.model),
		fallback: () => undefined,
	});
	expect([...resolver.listAliases()]).toEqual([]);
	// The listing itself started the load; awaiting current() joins that in-flight load.
	expect(server.requests).toEqual([VERSION_PATH]);
	await registry.current();
	expect([...resolver.listAliases()].map(alias => alias.id)).toEqual([STABLE_NAME]);
});

test("the gateway lists the stable name and routes it to the caller's usable candidate", async () => {
	await withEnv(NO_PROVIDER_ENV, async () => {
		registerMockApi();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-model-registry-"));
		const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
			usageProviderResolver: () => undefined,
		});
		storage.keys.setRuntime("openrouter", "openrouter-key");
		const anthropic = createMockModel({ provider: "anthropic", id: candidates[0].modelId });
		const openrouter = createMockModel({ provider: "openrouter", id: candidates[1].modelId });
		anthropic.push({ content: ["routed to anthropic"] });
		openrouter.push({ content: ["routed to openrouter"] });
		const server = fakeRegistryServer({ version: "1", registry: { entries: { [STABLE_NAME]: { candidates } } } });
		const registry = new CompassModelRegistry(registryOptions(server));
		const resolver = createStableNameResolver({
			registry,
			resolveStorage: () => storage,
			lookupModel: catalog(anthropic.model, openrouter.model),
			fallback: () => undefined,
		});
		await registry.current();
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			authorize: req => (req.headers.get("authorization") === "Bearer gateway-token" ? agent("owner-1") : null),
			storage,
			resolveStorage: () => storage,
			resolveModel: resolver.resolveModel,
			listAliases: resolver.listAliases,
			listModels: () => [anthropic.model, openrouter.model],
			version: "test",
		});
		try {
			const headers = { Authorization: "Bearer gateway-token" };
			const list = await fetch(`${gateway.url}/v1/models`, { headers });
			expect(list.status).toBe(200);
			expect(await list.json()).toMatchObject({
				data: expect.arrayContaining([expect.objectContaining({ id: STABLE_NAME })]),
			});
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ model: STABLE_NAME, messages: [{ role: "user", content: "hello" }], stream: false }),
			});
			expect(response.status).toBe(200);
			expect(openrouter.calls).toHaveLength(1);
			expect(anthropic.calls).toHaveLength(0);
		} finally {
			await gateway.close();
			storage.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
