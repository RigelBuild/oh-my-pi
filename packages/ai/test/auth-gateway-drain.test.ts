import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { bearerTokenAuthorizer, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => clearCustomApis());

test("draining leaves an active model response alive until it completes", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-drain-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("mock", "test-key");
	let release: () => void = () => {};
	let entered: () => void = () => {};
	const active = new Promise<void>(resolve => {
		entered = resolve;
	});
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const mock = createMockModel({
		handler: async () => {
			entered();
			await gate;
			return { content: ["completed after SIGTERM"] };
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer(["test-token"]),
		storage,
		resolveModel: () => mock.model,
	});
	try {
		const response = fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model: mock.model.id, messages: [{ role: "user", content: "hi" }], stream: false }),
		});
		await active;
		const closing = gateway.close(1000);
		release();
		const result = await response;
		expect(result.status).toBe(200);
		expect((await result.text()).includes("completed after SIGTERM")).toBe(true);
		await closing;
	} finally {
		release();
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("drain deadline aborts an in-flight request", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-drain-deadline-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("mock", "test-key");
	const active = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	let requestSignal: AbortSignal | undefined;
	const mock = createMockModel({
		handler: async (_context, options) => {
			const signal = options?.signal;
			requestSignal = signal;
			active.resolve();
			if (!signal) throw new Error("Expected gateway request signal");
			await new Promise<void>(resolve => {
				if (signal.aborted) {
					resolve();
				} else {
					signal.addEventListener("abort", () => resolve(), { once: true });
				}
			});
			aborted.resolve();
			throw signal.reason;
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer(["test-token"]),
		storage,
		resolveModel: () => mock.model,
	});
	try {
		const response = fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model: mock.model.id, messages: [{ role: "user", content: "hi" }], stream: false }),
		});
		await active.promise;
		const closing = gateway.close(25);
		await closing;
		await aborted.promise;
		expect(requestSignal?.aborted).toBe(true);
		await response.catch(() => undefined);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("omitted drain duration immediately aborts an active request", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-drain-immediate-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("mock", "test-key");
	const active = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const mock = createMockModel({
		handler: async (_context, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("Expected gateway request signal");
			active.resolve();
			if (!signal.aborted)
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			aborted.resolve();
			throw signal.reason;
		},
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer(["test-token"]),
		storage,
		resolveModel: () => mock.model,
	});
	try {
		const response = fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model: mock.model.id, messages: [{ role: "user", content: "hi" }], stream: false }),
		});
		await active.promise;
		await gateway.close();
		await aborted.promise;
		await response.catch(() => undefined);
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("rejects drain durations that cannot be represented by a timer", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-drain-invalid-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		authorize: bearerTokenAuthorizer([]),
		storage,
		resolveModel: () => undefined,
	});
	try {
		for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2_147_483_648]) {
			await expect(gateway.close(duration)).rejects.toThrow(RangeError);
		}
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
