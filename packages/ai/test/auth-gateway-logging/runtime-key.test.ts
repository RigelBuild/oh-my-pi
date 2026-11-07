import { expect, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { captureLogs, secret } from "./capture";

test("a runtime key succeeds without a fabricated stored row or quota window", async () => {
	registerMockApi();
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storage.keys.setRuntime("mock", secret.apiA);
	const model = createMockModel({
		handler: {
			content: [secret.response],
			responseHeaders: { "x-private": secret.header },
			responseRequestId: secret.metadata,
		},
	});
	const router = createAuthGatewayRouter({ storage, resolveModel: () => model });
	try {
		const response = await router.route(
			new Request("http://gateway/v1/chat/completions", {
				method: "POST",
				headers: { authorization: `Bearer ${secret.inbound}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					messages: [{ role: "user", content: secret.request }],
					stream: false,
				}),
			}),
			"peer",
			{ kind: "agent", agentAccountId: "pool" },
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(secret.response);
		expect(capture.matching("auth-gateway credential selected")).toHaveLength(1);
		expect(capture.matching("auth-gateway provider response")).toHaveLength(1);
		for (const event of [
			...capture.matching("auth-gateway credential selected"),
			...capture.matching("auth-gateway provider response"),
		]) {
			expect(event.context).not.toHaveProperty("credentialId");
			expect(event.context?.requestId).toMatch(/^[0-9a-f-]{36}$/);
		}
		expect(capture.matching("auth-gateway quota observation")).toHaveLength(0);
		await capture.assertSafe();
	} finally {
		router.close();
		storage.close();
		await capture.close();
	}
});
