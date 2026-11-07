import { expect, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { captureLogs, secret } from "./capture";

test("pool-scoped routes preserve identical row IDs and stream terminal failures", async () => {
	registerMockApi();
	const capture = await captureLogs();
	const a = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const b = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await a.credentials.set("mock", [{ type: "api_key", key: secret.apiA }]);
	await b.credentials.set("mock", [{ type: "api_key", key: secret.apiB }]);
	let terminal = false;
	const model = createMockModel({
		handler: () =>
			terminal
				? { stopReason: "error", errorMessage: secret.error }
				: { content: [secret.response], responseHeaders: { "x-private": secret.header } },
	});
	const router = createAuthGatewayRouter({
		storage: a,
		resolveStorage: caller => (caller.ownerUserId === "pool-A" ? a : b),
		resolveModel: () => model,
	});
	const send = (pool: string, native: boolean) =>
		router.route(
			new Request(`http://gateway${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
				method: "POST",
				headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
				body: JSON.stringify(
					native
						? {
								modelId: model.id,
								context: { messages: [{ role: "user", content: secret.request, timestamp: 0 }] },
								stream: true,
							}
						: { model: model.id, messages: [{ role: "user", content: secret.request }], stream: true },
				),
			}),
			"peer",
			{ kind: "agent", agentAccountId: "agent", ownerUserId: pool },
		);
	try {
		for (const [pool, native] of [
			["pool-A", false],
			["pool-B", true],
		] as const) {
			const response = await send(pool, native);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain(secret.response);
		}
		const selected = capture.matching("auth-gateway credential selected");
		expect(selected.map(event => event.context?.pool)).toEqual(["pool-A", "pool-B"]);
		expect(selected.map(event => event.context?.credentialId)).toEqual([
			a.credentials.list("mock")[0]?.id,
			b.credentials.list("mock")[0]?.id,
		]);
		expect(selected[0]?.context?.requestId).not.toBe(selected[1]?.context?.requestId);
		terminal = true;
		for (const native of [false, true]) {
			const response = await send("pool-B", native);
			await response.text();
		}
		const failures = capture.matching("auth-gateway request failed");
		expect(failures).toHaveLength(2);
		expect(
			failures.every(
				event =>
					event.context?.pool === "pool-B" && event.context?.credentialId === b.credentials.list("mock")[0]?.id,
			),
		).toBe(true);
		await capture.assertSafe();
	} finally {
		router.close();
		a.close();
		b.close();
		await capture.close();
	}
});
