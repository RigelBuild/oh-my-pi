import { expect, test } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { StreamOptions } from "@oh-my-pi/pi-ai/types";
import { captureLogs, secret } from "./capture";

test("a delayed A response uses its captured stream wrapper after B is selected", async () => {
	registerMockApi();
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	await storage.credentials.set("mock", [
		{ type: "api_key", key: secret.apiA },
		{ type: "api_key", key: secret.apiB },
	]);
	const rows = storage.credentials.list("mock");
	let delayed: StreamOptions["onResponse"];
	const bearers: string[] = [];
	let calls = 0;
	const model = createMockModel({
		handler: async (_context, options) => {
			const bearer = options?.apiKey;
			if (typeof bearer !== "string") throw new Error("expected resolved attempt bearer");
			bearers.push(bearer);
			if (calls++ === 0) {
				delayed = options?.onResponse;
				throw new ProviderHttpError(`usage limit reached ${secret.error}`, 429);
			}
			if (!delayed) throw new Error("expected first attempt response observer");
			await delayed({
				status: 429,
				headers: { "retry-after-ms": "7", "x-private": secret.header },
				metadata: { raw: secret.raw, body: secret.response },
			});
			return { content: [secret.response], responseHeaders: { "x-private": secret.header } };
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
		await response.text();
		// Session hashing chooses the first row; A and B name attempt order, not insertion order.
		expect(bearers).toHaveLength(2);
		expect(new Set(bearers)).toEqual(new Set([secret.apiA, secret.apiB]));
		const rowA = rows.find(row => row.credential.type === "api_key" && row.credential.key === bearers[0]);
		const rowB = rows.find(row => row.credential.type === "api_key" && row.credential.key === bearers[1]);
		if (!rowA || !rowB) throw new Error("expected rows for both sent bearers");
		const responses = capture.matching("auth-gateway provider response");
		expect(responses).toHaveLength(2);
		expect(responses.map(event => [event.context?.credentialId, event.context?.status])).toEqual([
			[rowA.id, 429],
			[rowB.id, 200],
		]);
		expect(responses[0]?.context?.retryAfterMs).toBe(7);
		const selections = capture.matching("auth-gateway credential selected");
		expect(selections).toHaveLength(2);
		expect(selections.map(event => event.context?.credentialId)).toEqual([rowA.id, rowB.id]);
		const selectedB = selections[1];
		const delayedA = responses[0];
		if (!selectedB || !delayedA) throw new Error("expected selection B and delayed response A");
		expect(capture.events.indexOf(selectedB)).toBeLessThan(capture.events.indexOf(delayedA));
		await capture.assertSafe();
	} finally {
		router.close();
		storage.close();
		await capture.close();
	}
});
