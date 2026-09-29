import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
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
		bearerTokens: ["test-token"],
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
