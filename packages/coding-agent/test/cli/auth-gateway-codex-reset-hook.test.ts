import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import {
	createGatewayCodexResetHook,
	runGatewayCodexResetSweep,
	type GatewayCodexResetCoordinator,
} from "../../src/cli/auth-gateway-cli";
import { Settings } from "../../src/config/settings";
import { cfgCodexResetsAutoRedeem } from "../../src/session/settings";

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
});

async function setup(enabled = true) {
	let now = Date.now();
	const storage = await AuthStorage.create(":memory:");
	storages.push(storage);
	await storage.credentials.set("openai-codex", [
		{
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: now + 3600_000,
			accountId: "acct",
			email: "test@example.com",
		},
	]);
	const stored = storage.credentials.list("openai-codex")[0];
	if (!stored) throw new Error("missing credential");
	const settings = Settings.isolated();
	if (enabled) cfgCodexResetsAutoRedeem.set(settings, "yes");
	const limit = (id: string, usedFraction: number): UsageLimit => ({
		id,
		label: id,
		scope: { provider: "openai-codex", shared: true },
		window: { id: id.endsWith("secondary") ? "7d" : "5h", label: id, resetsAt: now + 4 * 3600_000 },
		amount: { unit: "percent", usedFraction },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	});
	let weekly = 1;
	let primary = 0.2;
	let spark = 0.2;
	let unavailable = false;
	const report = spyOn(storage.usage, "report").mockImplementation(async (_provider, _credential, options) => {
		if (!options?.fresh || unavailable) return null;
		return {
			provider: "openai-codex",
			fetchedAt: now,
			limits: [
				limit("openai-codex:primary", primary),
				limit("openai-codex:secondary", weekly),
				limit("openai-codex:spark:secondary", spark),
			],
			metadata: { accountId: "acct", email: "test@example.com", limitReached: true },
		} satisfies UsageReport;
	});
	const list = spyOn(storage.resets, "list").mockResolvedValue([
		{
			provider: "openai-codex",
			credentialId: stored.id,
			accountId: "acct",
			email: "test@example.com",
			active: true,
			availableCount: 1,
			credits: [{ id: "credit", expiresAt: new Date(now + 3600_000).toISOString() }],
		},
	]);
	const redeem = spyOn(storage.resets, "redeem").mockResolvedValue({
		ok: true,
		code: "reset",
		provider: "openai-codex",
	});
	const coordinator: GatewayCodexResetCoordinator = {
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		inFlightByCredential: new Map(),
		exhaustedSinceByCredential: new Map(),
	};
	const hook = createGatewayCodexResetHook({ storage, settings, coordinator, now: () => now });
	const call = () =>
		hook({
			provider: "openai-codex",
			credentialId: stored.id,
			modelId: "gpt-5",
			signal: new AbortController().signal,
		});
	return {
		storage,
		hook,
		call,
		report,
		list,
		redeem,
		coordinator,
		advance: (ms: number) => {
			now += ms;
		},
		setWeekly: (value: number) => {
			weekly = value;
		},
		setPrimary: (value: number) => {
			primary = value;
		},
		setSpark: (value: number) => {
			spark = value;
		},
		setUnavailable: (value: boolean) => {
			unavailable = value;
		},
	};
}

describe("gateway Codex reset hook", () => {
	it("redeems after five minutes and a fresh final read", async () => {
		const s = await setup();
		expect(await s.call()).toBe(false);
		s.advance(300_000);
		expect(await s.call()).toBe(true);
		expect(s.report).toHaveBeenCalledTimes(3);
		expect(s.report.mock.calls.every(call => call[2]?.fresh === true)).toBe(true);
		expect(s.redeem).toHaveBeenCalledTimes(1);
	});
	it("resets the clock on a lower read", async () => {
		const s = await setup();
		await s.call();
		s.advance(150_000);
		s.setWeekly(0.998);
		await s.call();
		s.setWeekly(1);
		s.advance(150_000);
		expect(await s.call()).toBe(false);
		expect(s.redeem).not.toHaveBeenCalled();
	});
	it("does not spend when the final read is lower", async () => {
		const s = await setup();
		await s.call();
		s.advance(300_000);
		const original = s.report.getMockImplementation();
		let reads = 0;
		s.report.mockImplementation(async (...args) => {
			reads++;
			if (reads === 2) s.setWeekly(0.5);
			return original ? original(...args) : null;
		});
		expect(await s.call()).toBe(false);
		expect(s.redeem).not.toHaveBeenCalled();
		expect(s.coordinator.exhaustedSinceByCredential.size).toBe(0);
	});
	it("clears the clock on a null fresh read", async () => {
		const s = await setup();
		await s.call();
		s.advance(300_000);
		s.setUnavailable(true);
		await s.call();
		s.setUnavailable(false);
		expect(await s.call()).toBe(false);
		expect(s.redeem).not.toHaveBeenCalled();
	});
	it("does not start the clock for a 429 below the weekly threshold", async () => {
		const s = await setup();
		s.setWeekly(0.998);
		await s.call();
		s.advance(300_000);
		expect(await s.call()).toBe(false);
		expect(s.coordinator.exhaustedSinceByCredential.size).toBe(0);
		expect(s.list).not.toHaveBeenCalled();
		expect(s.redeem).not.toHaveBeenCalled();
	});
	it("does not start the clock for 5h-only exhaustion", async () => {
		const s = await setup();
		s.setWeekly(0.2);
		s.setPrimary(1);
		await s.call();
		s.advance(300_000);
		expect(await s.call()).toBe(false);
		expect(s.coordinator.exhaustedSinceByCredential.size).toBe(0);
		expect(s.list).not.toHaveBeenCalled();
		expect(s.redeem).not.toHaveBeenCalled();
	});
	it("does not start the clock for Spark-only exhaustion", async () => {
		const s = await setup();
		s.setWeekly(0.2);
		s.setSpark(1);
		await s.call();
		s.advance(300_000);
		expect(await s.call()).toBe(false);
		expect(s.coordinator.exhaustedSinceByCredential.size).toBe(0);
		expect(s.list).not.toHaveBeenCalled();
		expect(s.redeem).not.toHaveBeenCalled();
	});
	it("does not list or redeem without consent", async () => {
		const s = await setup(false);
		await s.call();
		s.advance(300_000);
		await s.call();
		expect(s.list).not.toHaveBeenCalled();
		expect(s.redeem).not.toHaveBeenCalled();
		expect(s.report).not.toHaveBeenCalled();
	});
	it("shares one redeem among concurrent hooks", async () => {
		const s = await setup();
		expect(await Promise.all([s.call(), s.call()])).toEqual([false, false]);
		expect(s.report).toHaveBeenCalledTimes(1);
		s.advance(300_000);
		expect(await Promise.all([s.call(), s.call()])).toEqual([true, true]);
		expect(s.report).toHaveBeenCalledTimes(3);
		expect(s.redeem).toHaveBeenCalledTimes(1);
	});
	it("sweeps without traffic", async () => {
		const s = await setup();
		const models: string[] = [];
		const sweep = () =>
			runGatewayCodexResetSweep({
				storage: s.storage,
				hook: context => {
					models.push(context.modelId);
					return s.hook(context);
				},
				signal: new AbortController().signal,
			});
		await sweep();
		s.advance(300_000);
		await sweep();
		expect(models).toEqual(["", ""]);
		expect(s.redeem).toHaveBeenCalledTimes(1);
	});
});
