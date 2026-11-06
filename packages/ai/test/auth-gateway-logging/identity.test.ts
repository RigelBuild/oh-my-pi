import { expect, spyOn, test } from "bun:test";
import { buildGatewayApiKeyResolver } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { gatewayLogContext, logGatewayProviderResponse } from "@oh-my-pi/pi-ai/auth-gateway/logging";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { captureLogs, secret } from "./capture";

test("binds repeated rotations, delayed A and previousKey to exact rows across admitted pools", async () => {
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const model = createMockModel({ provider: "openai-codex", id: "resolved-model" });
	const context = gatewayLogContext(
		"generated-request",
		{ kind: "agent", agentAccountId: "agent", ownerUserId: "owner-pool" },
		"format",
		model.provider,
		model.id,
	);
	const a = { apiKey: secret.apiA, credentialId: 11 };
	const b = { apiKey: secret.apiB, credentialId: 12 };
	const c = { apiKey: secret.access, credentialId: 13 };
	const get = spyOn(storage.keys, "getWithCredential")
		.mockResolvedValueOnce(b)
		.mockResolvedValueOnce(c)
		.mockResolvedValueOnce(a);
	const reached = spyOn(storage.limits, "markReached").mockResolvedValue({ switched: true });
	const callbacks: Array<number | undefined> = [];
	const failure = Object.assign(new ProviderHttpError(`usage limit reached ${secret.error}`, 429), {
		stack: secret.stack,
		cause: new Error(secret.cause),
		info: { raw: secret.raw },
		capturedBody: secret.captured,
		headers: { "retry-after": "0", "x-private": secret.header },
		metadata: secret.metadata,
	});
	try {
		const resolve = buildGatewayApiKeyResolver(
			storage,
			model,
			"session",
			a,
			new AbortController().signal,
			"format",
			"peer",
			undefined,
			undefined,
			id => callbacks.push(id),
			context,
		);
		expect(await resolve({ error: failure, lastChance: true })).toEqual(b);
		expect(await resolve({ error: failure, lastChance: true })).toEqual(c);
		// A late failure explicitly names A although C is now current.
		expect(await resolve({ error: failure, lastChance: true, previousKey: a.apiKey })).toEqual(a);
		logGatewayProviderResponse(context, {
			status: 429,
			credentialId: a.credentialId,
			headers: { "retry-after-ms": "25", "x-private": secret.header },
			metadata: { body: secret.response },
		});
		const other = gatewayLogContext(
			"other-request",
			{ kind: "agent", agentAccountId: "other-pool" },
			"non-chat",
			model.provider,
			model.id,
		);
		const otherResolve = buildGatewayApiKeyResolver(
			storage,
			model,
			"other-session",
			{ apiKey: secret.apiB, credentialId: 11 },
			new AbortController().signal,
			"non-chat",
			"peer",
			undefined,
			undefined,
			undefined,
			other,
		);
		await otherResolve({ error: undefined, lastChance: false });
		logGatewayProviderResponse(other, { status: 200, credentialId: 11, headers: {} });
		expect(callbacks).toEqual([11, 12, 11]);
		expect(reached.mock.calls.map(call => call[2]?.apiKey)).toEqual([a.apiKey, b.apiKey, a.apiKey]);
		expect(
			capture.matching("auth-gateway provider attempt failed").map(event => event.context?.credentialId),
		).toEqual([11, 12, 11]);
		expect(capture.matching("auth-gateway provider response").map(event => event.context)).toEqual([
			{ ...context, credentialId: 11, status: 429, retryAfterMs: 25 },
			{ ...other, credentialId: 11, status: 200 },
		]);
		expect(capture.matching("auth-gateway provider attempt failed")[0]?.context?.retryAfterMs).toBe(0);
		await capture.assertSafe();
	} finally {
		get.mockRestore();
		reached.mockRestore();
		storage.close();
		await capture.close();
	}
});

test("snapshots failed identity before an awaited refresh and never invents row provenance", async () => {
	const capture = await captureLogs();
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const model = createMockModel();
	const pending = Promise.withResolvers<{ apiKey: string; credentialId: number }>();
	const get = spyOn(storage.keys, "getWithCredential")
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValueOnce({ apiKey: secret.apiB, credentialId: 2 });
	const invalidated = spyOn(storage.limits, "invalidateMatching").mockResolvedValue(false);
	const context = gatewayLogContext(
		"refresh-request",
		{ kind: "agent", agentAccountId: "pool" },
		"test",
		model.provider,
		model.id,
	);
	try {
		const resolve = buildGatewayApiKeyResolver(
			storage,
			model,
			"session",
			{ apiKey: secret.apiA, credentialId: 1 },
			new AbortController().signal,
			"test",
			"peer",
			undefined,
			undefined,
			undefined,
			context,
		);
		const refresh = resolve({ error: new ProviderHttpError(secret.error, 401), lastChance: false });
		await resolve({ error: new ProviderHttpError(secret.error, 401), lastChance: true, previousKey: secret.apiA });
		pending.resolve({ apiKey: secret.access, credentialId: 1 });
		await refresh;
		await resolve({
			error: new ProviderHttpError(secret.error, 401),
			lastChance: false,
			previousKey: "untracked-key",
		});
		expect(
			capture.matching("auth-gateway provider attempt failed").map(event => event.context?.credentialId),
		).toEqual([1, 1, undefined]);
		await capture.assertSafe();
	} finally {
		get.mockRestore();
		invalidated.mockRestore();
		storage.close();
		await capture.close();
	}
});
