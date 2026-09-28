import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import type { GatewayUsageEvent } from "@oh-my-pi/pi-ai/auth-gateway";
import type { Usage } from "@oh-my-pi/pi-ai/types";

const usage: Usage = {
	input: 12,
	output: 4,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 19,
	cost: { input: 0.12, output: 0.04, cacheRead: 0.01, cacheWrite: 0.01, total: 0.18 },
};
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Harness {
	url: string;
	storage: AuthStorage;
	handle: AuthGatewayServerHandle;
	dir: string;
	events: GatewayUsageEvent[];
	model: MockModel;
}

async function boot(onUsage?: (event: GatewayUsageEvent) => void | Promise<void>): Promise<Harness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-usage-hook-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("openrouter", "test-key");
	const model = createMockModel({ provider: "openrouter", id: "usage-hook-model" });
	const events: GatewayUsageEvent[] = [];
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => model,
		version: "test",
		onUsage: event => {
			events.push(event);
			return onUsage?.(event);
		},
	});
	return { url: handle.url, storage, handle, dir, events, model };
}

async function close(harness: Harness | undefined): Promise<void> {
	if (!harness) return;
	await harness.handle.close();
	harness.storage.close();
	await fs.rm(harness.dir, { recursive: true, force: true });
}

function chatRequest(url: string, stream = false): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify({ model: "usage-hook-model", messages: [{ role: "user", content: "hello" }], stream }),
	});
}

describe("auth-gateway onUsage hook", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await close(harness);
		harness = undefined;
	});

	it("reports completed non-stream chat usage with the response request id", async () => {
		harness = await boot();
		harness.model.push({ content: ["ok"], usage });
		const response = await chatRequest(harness.url);
		expect(response.status).toBe(200);
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]).toMatchObject({
			requestId: response.headers.get("x-request-id"),
			provider: "openrouter",
			model: "usage-hook-model",
			usage,
			outcome: "ok",
		});
	});

	it("attributes usage to the API key that served the call", async () => {
		harness = await boot();
		harness.model.push({ content: ["ok"], usage });
		const response = await chatRequest(harness.url);
		expect(response.status).toBe(200);
		expect(harness.events[0]?.account).toBe(`key:${Bun.hash("test-key").toString(36)}`);
	});

	it("attributes retried usage to the sibling credential that served it", async () => {
		registerMockApi();
		let attempt = 0;
		const model = createMockModel({
			provider: "mock",
			id: "usage-hook-rotation-model",
			handler: () => {
				if (attempt++ === 0) throw new ProviderHttpError("expired credential", 401);
				return { content: ["ok"], usage };
			},
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-usage-rotation-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		await storage.credentials.set("mock", [
			{ type: "api_key", key: "key-one" },
			{ type: "api_key", key: "key-two" },
		]);
		const events: GatewayUsageEvent[] = [];
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => model,
			version: "test",
			onUsage: event => {
				events.push(event);
			},
		});
		try {
			const response = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hello" }] }),
			});
			expect(response.status).toBe(200);
			expect(events).toHaveLength(1);
			expect(model.calls).toHaveLength(2);
			expect(model.calls.at(-1)?.options?.apiKey).toBeDefined();
			const account = `key:${Bun.hash("key-two").toString(36)}`;
			expect(events[0]?.account).toBe(account);
			expect(events[0]?.account).not.toBe(`key:${Bun.hash("key-one").toString(36)}`);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("isolates route usage from a mutating hook while observing the original", async () => {
		harness = await boot(event => {
			event.usage.input = 0;
		});
		harness.model.push({ content: ["ok"], usage });
		const observed: Array<{ usage: { input: number } }> = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));

		const response = await chatRequest(harness.url);
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body).toMatchObject({ usage: { prompt_tokens: usage.input + 3, completion_tokens: usage.output } });
		expect(observed).toEqual([expect.objectContaining({ usage: expect.objectContaining({ input: usage.input }) })]);
	});

	it("isolates client identity from a mutating hook while observing the original", async () => {
		harness = await boot(event => {
			event.client.installId = "mutated";
		});
		harness.model.push({ content: ["ok"], usage });
		const observed: Array<{ client?: { installId?: string } }> = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));
		const response = await fetch(`${harness.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
				"x-omp-install-id": "original-install",
			},
			body: JSON.stringify({ model: "usage-hook-model", messages: [{ role: "user", content: "hello" }] }),
		});
		expect(response.status).toBe(200);
		expect(observed).toHaveLength(1);
		expect(observed[0]?.client?.installId).toBe("original-install");
		expect(harness.events[0]?.client.installId).toBe("mutated");
	});

	it("reports stream completion once, and maps error and aborted outcomes", async () => {
		const settled = Promise.withResolvers<GatewayUsageEvent>();
		harness = await boot(event => settled.resolve(event));
		const model = harness.model;
		model.push({ content: ["streamed"], usage });
		const response = await chatRequest(harness.url, true);
		expect(response.status).toBe(200);
		await response.text();
		const streamed = await settled.promise;
		expect(streamed).toMatchObject({ outcome: "ok", usage, requestId: response.headers.get("x-request-id") });
		expect(harness.events).toHaveLength(1);

		model.push({ content: ["partial"], usage, stopReason: "error" });
		const failed = await chatRequest(harness.url);
		expect(failed.status).not.toBe(200);
		expect(harness.events).toHaveLength(2);
		expect(harness.events[1]?.outcome).toBe("error");

		model.push({ content: ["partial"], usage, stopReason: "aborted" });
		await chatRequest(harness.url);
		expect(harness.events).toHaveLength(3);
		expect(harness.events[2]?.outcome).toBe("aborted");
	});

	it("skips zero usage and isolates throwing hooks from observe and response", async () => {
		harness = await boot(() => {
			throw new Error("consumer failed");
		});
		const model = harness.model;
		const observed: unknown[] = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => observed.push(entry));
		model.push({ content: ["ok"], usage: zeroUsage });
		const empty = await chatRequest(harness.url);
		expect(empty.status).toBe(200);
		expect(harness.events).toHaveLength(0);

		model.push({ content: ["ok"], usage });
		const response = await chatRequest(harness.url);
		expect(response.status).toBe(200);
		expect(harness.events).toHaveLength(1);
		expect(observed).toHaveLength(1);
	});

	it("contains rejected async hooks without an unhandled rejection", async () => {
		harness = await boot(async () => {
			throw new Error("consumer rejected");
		});
		let unhandled = 0;
		const unhandledEvent = Promise.withResolvers<void>();
		const listener = () => {
			unhandled++;
			unhandledEvent.resolve();
		};
		process.on("unhandledRejection", listener);
		try {
			harness.model.push({ content: ["ok"], usage });
			const response = await chatRequest(harness.url);
			expect(response.status).toBe(200);
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
			expect(unhandled).toBe(0);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});
});
