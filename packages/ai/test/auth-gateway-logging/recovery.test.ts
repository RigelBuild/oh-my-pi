import { expect, spyOn, test } from "bun:test";
import { buildGatewayApiKeyResolver, resolveGatewayApiKey } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import {
	gatewayLogContext,
	logGatewayRequestFailure,
	logGatewayProviderResponse,
} from "@oh-my-pi/pi-ai/auth-gateway/logging";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { captureLogs, secret } from "./capture";

test("recovery preserves same-key retry, no-sibling stop and prepaid policy without invented reset", async () => {
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const model = createMockModel({ provider: "anthropic" });
	const signal = new AbortController().signal;
	const initial = { apiKey: secret.apiA, credentialId: 1 };
	const context = gatewayLogContext(
		"policy-request",
		{ kind: "agent", agentAccountId: "pool" },
		"test",
		model.provider,
		model.id,
	);
	const get = spyOn(storage.keys, "getWithCredential").mockResolvedValue(initial);
	const mark = spyOn(storage.limits, "markReached").mockResolvedValue({ switched: false, retryAtMs: 1900000000000 });
	const invalidate = spyOn(storage.limits, "invalidateMatching");
	try {
		const restored = buildGatewayApiKeyResolver(
			storage,
			model,
			"session",
			initial,
			signal,
			"test",
			"peer",
			undefined,
			async () => true,
			undefined,
			context,
		);
		expect(
			await restored({ error: new ProviderHttpError(`usage limit reached ${secret.error}`, 429), lastChance: true }),
		).toEqual({ ...initial, afterSiblingWait: true });
		expect(mark).not.toHaveBeenCalled();
		const rejected = buildGatewayApiKeyResolver(
			storage,
			model,
			"session",
			initial,
			signal,
			"test",
			"peer",
			undefined,
			async () => {
				throw new Error(secret.cause);
			},
			undefined,
			context,
		);
		expect(
			await rejected({
				error: new ProviderHttpError(`credit balance is too low ${secret.error}`, 400),
				lastChance: true,
			}),
		).toBeUndefined();
		expect(mark).toHaveBeenCalledTimes(1);
		expect(mark.mock.calls[0]?.[2]).toMatchObject({ apiKey: initial.apiKey, signal, providerTimed: false });
		expect(mark.mock.calls[0]?.[2]?.retryAfterMs).toBeGreaterThan(0);
		expect(invalidate).not.toHaveBeenCalled();
		expect(capture.matching("auth-gateway usage-limit recovery failed")).toHaveLength(1);
		for (const event of capture.events) {
			expect(event.context).not.toHaveProperty("resetAtMs");
			expect(event.context).not.toHaveProperty("retryAtMs");
			expect(event.context).not.toHaveProperty("window");
		}
		await capture.assertSafe();
	} finally {
		get.mockRestore();
		mark.mockRestore();
		invalidate.mockRestore();
		storage.close();
		await capture.close();
	}
});

test("setup failures and polluted runtime inputs only emit authorized plain fields", async () => {
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const model = createMockModel();
	const context = gatewayLogContext(
		"setup-request",
		{ kind: "agent", agentAccountId: "pool" },
		"test",
		model.provider,
		model.id,
	);
	const polluted = Object.assign(context, {
		token: secret.apiA,
		body: secret.request,
		error: new Error(secret.error),
	});
	const get = spyOn(storage.keys, "getWithCredential").mockRejectedValue(
		Object.assign(new Error(secret.error), { stack: secret.stack, cause: new Error(secret.cause) }),
	);
	try {
		const result = await resolveGatewayApiKey(
			storage,
			model,
			"session",
			new AbortController().signal,
			"peer",
			polluted,
		);
		expect(result).toHaveProperty("setupReason", "store_error");
		logGatewayRequestFailure(polluted, Number.NaN, Number.POSITIVE_INFINITY);
		logGatewayProviderResponse(polluted, { status: Number.NaN, credentialId: 1, headers: { "retry-after": "100" } });
		expect(capture.matching("auth-gateway provider response")).toHaveLength(0);
		const failure = capture.matching("auth-gateway request failed").at(-1);
		expect(failure?.context).toEqual({
			requestId: "setup-request",
			pool: "pool",
			format: "test",
			provider: model.provider,
			model: model.id,
		});
		await capture.assertSafe();
		get.mockResolvedValueOnce(undefined);
		const missing = await resolveGatewayApiKey(
			storage,
			model,
			"session",
			new AbortController().signal,
			"peer",
			polluted,
		);
		expect(missing).toHaveProperty("setupReason", "no_credential");
		expect(capture.matching("auth-gateway request failed").at(-1)?.context).toEqual({
			requestId: "setup-request",
			pool: "pool",
			format: "test",
			provider: model.provider,
			model: model.id,
			status: 401,
		});
		await capture.assertSafe();
	} finally {
		get.mockRestore();
		storage.close();
		await capture.close();
	}
});
