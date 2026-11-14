import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, type ResetCreditAccountStatus, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import {
	createGatewayClaudeResetHook,
	runGatewayClaudeResetSweep,
	type GatewayClaudeResetCoordinator,
} from "../../src/cli/auth-gateway-cli";
import { Settings } from "../../src/config/settings";
import {
	cfgClaudeResetsAutoRedeem,
	cfgClaudeResetsKeepCredits,
	cfgClaudeResetsMinBlockedMinutes,
} from "../../src/session/settings";

const storages: AuthStorage[] = [];
afterEach(() => {
	for (const storage of storages.splice(0)) storage.close();
});

function limit(id: "anthropic:5h" | "anthropic:7d", usedFraction: number): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider: "anthropic", windowId: id.endsWith("5h") ? "5h" : "7d", shared: true },
		window: {
			id,
			label: id,
			durationMs: id.endsWith("5h") ? 5 * 60 * 60_000 : 7 * 24 * 60 * 60_000,
			resetsAt: Date.now() + (id.endsWith("5h") ? 4 * 60 * 60_000 : 90 * 60_000),
		},
		amount: { unit: "percent", usedFraction, remainingFraction: 1 - usedFraction },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function status(report: UsageReport, clears: string[]): ResetCreditAccountStatus {
	return {
		provider: "anthropic",
		credentialId: 7,
		accountId: "acct-cedar",
		email: "cedar@example.com",
		active: true,
		availableCount: 1,
		redeemableCount: 1,
		eligible: true,
		nextCreditId: "cedar-credit",
		credits: [
			{ id: "cedar-credit", program: "cedar_ember", usable: true, remainingCount: 1, clears, blocking: clears },
		],
		report,
	};
}

function coordinator(): GatewayClaudeResetCoordinator {
	return {
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		inFlightByCredential: new Map(),
	};
}

async function setup(
	autoRedeem: "yes" | "no" | "unset",
	exhausted: "anthropic:5h" | "anthropic:7d",
	options: {
		drainFirst?: boolean;
		bankedReset?: boolean;
		keepCredits?: number;
		minBlockedMinutes?: number;
		secondAccount?: boolean;
	} = {},
) {
	const bankedReset = options.bankedReset ?? true;
	const storage = await AuthStorage.create(":memory:");
	storages.push(storage);
	const credential = {
		type: "oauth" as const,
		access: "access-cedar",
		refresh: "refresh-cedar",
		expires: Date.now() + 60 * 60_000,
		accountId: "acct-cedar",
		email: "cedar@example.com",
	};
	await storage.credentials.set("anthropic", [credential]);
	if (options.secondAccount) {
		await storage.credentials.set("anthropic", {
			type: "oauth",
			access: "access-sibling",
			refresh: "refresh-sibling",
			expires: Date.now() + 60 * 60_000,
			accountId: "acct-sibling",
			email: "sibling@example.com",
		});
	}
	const stored = storage.credentials.list("anthropic")[0];
	if (!stored || stored.credential.type !== "oauth") throw new Error("expected stored Claude credential");
	const settings = Settings.isolated();
	cfgClaudeResetsAutoRedeem.set(settings, autoRedeem);
	cfgClaudeResetsKeepCredits.set(settings, options.keepCredits ?? 0);
	cfgClaudeResetsMinBlockedMinutes.set(settings, options.minBlockedMinutes ?? 60);
	if (options.drainFirst) {
		const accountPolicy = { provider: "anthropic", account: { accountId: "acct-cedar" }, drainFirst: true };
		storage.setAccountPolicies({ accountPolicies: [accountPolicy], defaultReservePct: 10 });
	}
	const usage: UsageReport = {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			limit("anthropic:5h", exhausted === "anthropic:5h" ? 1 : 0.2),
			limit("anthropic:7d", exhausted === "anthropic:7d" ? 1 : 0.2),
		],
		metadata: { accountId: "acct-cedar", email: "cedar@example.com" },
		...(bankedReset
			? {
					resetCredits: {
						availableCount: 1,
						redeemableCount: 1,
						eligible: true,
						nextCreditId: "cedar-credit",
						credits: [
							{
								id: "cedar-credit",
								program: "cedar_ember",
								usable: true,
								remainingCount: 1,
								clears: ["anthropic:7d"],
							},
						],
					},
				}
			: {}),
	};
	const report = spyOn(storage.usage, "report").mockResolvedValue(usage);
	const statuses = bankedReset ? [{ ...status(usage, ["anthropic:7d"]), credentialId: stored.id }] : [];
	const list = spyOn(storage.resets, "list").mockResolvedValue(statuses);
	const redeem = spyOn(storage.resets, "redeem").mockResolvedValue({ ok: true, code: "reset", provider: "anthropic" });
	const hook = createGatewayClaudeResetHook({ storage, settings, coordinator: coordinator() });
	return { hook, list, redeem, report, credentialId: stored.id, storage };
}

describe("gateway Claude reset hook", () => {
	it("redeems an eligible Cedar reset covering the exhausted 7d limit once", async () => {
		const { hook, list, redeem, credentialId, report } = await setup("yes", "anthropic:7d");
		const signal = new AbortController().signal;
		expect(await hook({ provider: "anthropic", credentialId, modelId: "claude-sonnet", signal })).toBe(true);
		expect(report).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(redeem.mock.calls[0]?.[0].target).toMatchObject({
			provider: "anthropic",
			credentialId,
			creditId: "cedar-credit",
		});
	});

	it("shares one redeem between concurrent 429s on the same credential", async () => {
		const { hook, redeem, credentialId } = await setup("yes", "anthropic:7d");
		const signal = new AbortController().signal;
		const results = await Promise.all([
			hook({ provider: "anthropic", credentialId, modelId: "claude-sonnet", signal }),
			hook({ provider: "anthropic", credentialId, modelId: "claude-sonnet", signal }),
		]);
		expect(results).toEqual([true, true]);
		expect(redeem).toHaveBeenCalledTimes(1);
	});

	it("does not list or redeem when auto-redeem is unset", async () => {
		const { hook, list, redeem, credentialId } = await setup("unset", "anthropic:7d");
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).not.toHaveBeenCalled();
		expect(redeem).not.toHaveBeenCalled();
	});

	it("redeems an exhausted weekly reset for a drain-first account when auto-redeem is no", async () => {
		const { hook, list, redeem, credentialId } = await setup("no", "anthropic:7d", { drainFirst: true });
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(true);
		expect(list).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledTimes(1);
	});

	it("does not redeem when auto-redeem is no and the account is not drain-first", async () => {
		const { hook, list, redeem, credentialId } = await setup("no", "anthropic:7d");
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).not.toHaveBeenCalled();
		expect(redeem).not.toHaveBeenCalled();
	});

	it("keeps auto-redeem yes behavior for a drain-first account", async () => {
		const { hook, redeem, credentialId } = await setup("yes", "anthropic:7d", { drainFirst: true });
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(true);
		expect(redeem).toHaveBeenCalledTimes(1);
	});
	it("keeps auto-redeem unset disabled for a drain-first account", async () => {
		const { hook, list, redeem, credentialId } = await setup("unset", "anthropic:7d", { drainFirst: true });
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).not.toHaveBeenCalled();
		expect(redeem).not.toHaveBeenCalled();
	});

	it("keeps the last credit when drain-first auto-redeem has a credit reserve", async () => {
		const { hook, list, redeem, credentialId } = await setup("no", "anthropic:7d", {
			drainFirst: true,
			keepCredits: 1,
		});
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).toHaveBeenCalledTimes(1);
		expect(redeem).not.toHaveBeenCalled();
	});

	it("keeps the minimum blocked-time rule for drain-first auto-redeem", async () => {
		const { hook, list, redeem, credentialId } = await setup("no", "anthropic:7d", {
			drainFirst: true,
			minBlockedMinutes: 120,
		});
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).toHaveBeenCalledTimes(1);
		expect(redeem).not.toHaveBeenCalled();
	});

	it("does not redeem a drain-first account without a banked reset", async () => {
		const { hook, list, redeem, credentialId } = await setup("no", "anthropic:7d", {
			drainFirst: true,
			bankedReset: false,
		});
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).not.toHaveBeenCalled();
		expect(redeem).not.toHaveBeenCalled();
	});

	it("does not spend a weekly credit for an exhausted 5h-only block", async () => {
		const { hook, list, redeem, credentialId } = await setup("yes", "anthropic:5h");
		expect(
			await hook({
				provider: "anthropic",
				credentialId,
				modelId: "claude-sonnet",
				signal: new AbortController().signal,
			}),
		).toBe(false);
		expect(list).not.toHaveBeenCalled();
		expect(redeem).not.toHaveBeenCalled();
	});

	it("sweeps only 7d-exhausted accounts with reset inventory", async () => {
		const storage = await AuthStorage.create(":memory:");
		storages.push(storage);
		const accounts = [
			{ credentialId: 7, accountId: "acct-cedar", email: "cedar@example.com", active: false, position: 0 },
			{ credentialId: 8, accountId: "acct-half", email: "half@example.com", active: false, position: 1 },
			{ credentialId: 9, accountId: "acct-no-inventory", email: "none@example.com", active: false, position: 2 },
			{ credentialId: 10, accountId: "acct-second", email: "second@example.com", active: false, position: 3 },
		];
		spyOn(storage.oauth, "accounts").mockReturnValue(accounts);
		const report = (accountId: string, weekly: number, inventory: boolean): UsageReport => ({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [limit("anthropic:7d", weekly)],
			metadata: { accountId },
			...(inventory
				? {
						resetCredits: {
							availableCount: 1,
							redeemableCount: 1,
							eligible: true,
							nextCreditId: "cedar-credit",
							credits: [{ id: "cedar-credit", usable: true, clears: ["anthropic:7d"] }],
						},
					}
				: {}),
		});
		const reports = spyOn(storage.usage, "reports").mockResolvedValue([
			report("acct-cedar", 1, true),
			report("acct-half", 0.5, true),
			report("acct-no-inventory", 1, false),
			report("acct-second", 1, true),
		]);
		const calls: Array<{ provider: string; credentialId: number; modelId: string; signal: AbortSignal }> = [];
		const controller = new AbortController();
		await runGatewayClaudeResetSweep({
			storage,
			signal: controller.signal,
			hook: async ctx => {
				calls.push(ctx);
				return false;
			},
		});
		const reportOptions = reports.mock.calls[0]?.[0];
		expect(reportOptions?.signal).not.toBe(controller.signal);
		expect(reportOptions?.signal?.aborted).toBe(false);
		const sweepSignal = calls[0]?.signal;
		expect(sweepSignal).toBeInstanceOf(AbortSignal);
		expect(sweepSignal?.aborted).toBe(false);
		expect(calls.map(call => call.credentialId)).toEqual([7, 10]);
		expect(calls[1]?.signal).not.toBe(calls[0]?.signal);
		expect(calls[0]).toMatchObject({ provider: "anthropic", modelId: "" });
	});

	it("sweeps only drain-first accounts when auto-redeem is no", async () => {
		const storage = await AuthStorage.create(":memory:");
		storages.push(storage);
		const credentials = [
			{
				type: "oauth" as const,
				access: "cedar",
				refresh: "cedar",
				expires: Date.now() + 60_000,
				accountId: "acct-cedar",
			},
			{
				type: "oauth" as const,
				access: "sibling",
				refresh: "sibling",
				expires: Date.now() + 60_000,
				accountId: "acct-sibling",
			},
		];
		await storage.credentials.set("anthropic", credentials);
		const storedCredentials = storage.credentials.list("anthropic");
		const drainId = storedCredentials.find(
			row => row.credential.type === "oauth" && row.credential.accountId === "acct-cedar",
		)?.id;
		const siblingId = storedCredentials.find(
			row => row.credential.type === "oauth" && row.credential.accountId === "acct-sibling",
		)?.id;
		if (drainId === undefined || siblingId === undefined) throw new Error("expected both stored Claude accounts");
		storage.setAccountPolicies({
			accountPolicies: [{ provider: "anthropic", account: { accountId: "acct-cedar" }, drainFirst: true }],
			defaultReservePct: 10,
		});
		const resetReport = (accountId: string, creditId: string): UsageReport => ({
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [limit("anthropic:7d", 1)],
			metadata: { accountId },
			resetCredits: {
				availableCount: 1,
				redeemableCount: 1,
				eligible: true,
				nextCreditId: creditId,
				credits: [{ id: creditId, usable: true, clears: ["anthropic:7d"] }],
			},
		});
		spyOn(storage.usage, "reports").mockResolvedValue([
			resetReport("acct-cedar", "cedar-credit"),
			resetReport("acct-sibling", "sibling-credit"),
		]);
		spyOn(storage.usage, "report").mockImplementation(async (_provider, credential) =>
			credential.type === "oauth" && credential.accountId === "acct-sibling"
				? resetReport("acct-sibling", "sibling-credit")
				: resetReport("acct-cedar", "cedar-credit"),
		);
		const statuses = [
			{ ...status(resetReport("acct-cedar", "cedar-credit"), ["anthropic:7d"]), credentialId: drainId },
			{ ...status(resetReport("acct-sibling", "sibling-credit"), ["anthropic:7d"]), credentialId: siblingId },
		];
		const list = spyOn(storage.resets, "list").mockResolvedValue(statuses);
		const redeem = spyOn(storage.resets, "redeem").mockResolvedValue({
			ok: true,
			code: "reset",
			provider: "anthropic",
		});
		const settings = Settings.isolated();
		cfgClaudeResetsAutoRedeem.set(settings, "no");
		const hook = createGatewayClaudeResetHook({ storage, settings, coordinator: coordinator() });
		const hooked: number[] = [];
		await runGatewayClaudeResetSweep({
			storage,
			signal: new AbortController().signal,
			hook: async context => {
				hooked.push(context.credentialId);
				return hook(context);
			},
		});
		expect(hooked).toEqual([drainId, siblingId]);
		expect(list).toHaveBeenCalledTimes(1);
		expect(redeem).toHaveBeenCalledTimes(1);
		expect(redeem.mock.calls[0]?.[0].target.credentialId).toBe(drainId);
	});
});
