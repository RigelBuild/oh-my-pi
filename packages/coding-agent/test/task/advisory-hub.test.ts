import { afterEach, expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { AdvisoryHub, advisoryNow } from "../../src/task/advisory-hub";

const messaging = { status: "supported" } as const;

afterEach(() => {
	vi.useRealTimers();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

function fixture() {
	const hub = new AdvisoryHub();
	hub.attach({ sessionId: "parent", instanceId: "p", agentId: "Parent" });
	const ref = hub.mint({ childSessionId: "child", parentSessionId: "parent", messaging });
	hub.attachFrom("w1", { sessionId: "child", instanceId: "c", agentId: "Child" });
	return { hub, ref };
}

it("resets sources on wake and parked revival", () => {
	const { hub, ref } = fixture();
	hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
	hub.publishEvent("child", "c", { kind: "assistant-usage", id: "first", usage: { input: 5 } });
	expect(hub.current("child")?.workTokens).toBe(5);
	hub.terminal("child", ref.assignmentId);
	hub.wake("child");
	expect(hub.current("child")).toBeUndefined();
	hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
	const wake = hub.current("child");
	expect(wake?.ref.assignmentId).not.toBe(ref.assignmentId);
	expect(wake?.workTokens).toBeNull();
	hub.parkSession("child");
	hub.attachFrom("w2", { sessionId: "child", instanceId: "new", agentId: "Child" });
	hub.publishEvent("child", "new", { kind: "ready", at: advisoryNow() });
	expect(hub.current("child")?.ref.assignmentId).not.toBe(wake?.ref.assignmentId);
	expect(hub.current("child")?.workTokens).toBeNull();
});

it("keeps parked snapshots after their worker exits and expires them on release", () => {
	const clock = spyOn(performance, "now").mockReturnValue(10);
	try {
		const { hub } = fixture();
		hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
		clock.mockReturnValue(30);
		hub.parkSession("child");
		hub.detach("child", "c");
		hub.disposeHome("w1");
		clock.mockReturnValue(300);
		expect(hub.children("parent")).toMatchObject([{ phase: "paused", wallMs: 20 }]);
		hub.expireParked("child");
		expect(hub.children("parent")).toEqual([]);
		expect(hub.getAssignment("child")).toBeUndefined();
	} finally {
		clock.mockRestore();
	}
});

it("rejects public bound messages and does not buffer them", async () => {
	const { ref } = fixture();
	const bus = IrcBus.global();
	const receipt = await bus.send({
		from: "Parent",
		to: "Child",
		body: "private",
		advisoryBinding: { ref, branchId: ref.parentBranchId, senderInstanceId: "p", recipientInstanceId: "c" },
	});
	expect(receipt.outcome).toBe("failed");
	expect(bus.take("Child")).toBeUndefined();
});

it("cleans worker watches and timers while retaining other live instances", async () => {
	vi.useFakeTimers();
	const registry = AgentRegistry.global();
	const session = { deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	registry.register({ id: "Parent", displayName: "Parent", kind: "sub", session });
	registry.register({ id: "Child", displayName: "Child", kind: "sub", session });
	const { hub, ref } = fixture();
	registry.register({ id: "Sibling", displayName: "Sibling", kind: "sub", session });
	const sibling = hub.mint({ childSessionId: "sibling", parentSessionId: "parent", messaging });
	hub.attach({ sessionId: "sibling", instanceId: "s", agentId: "Sibling" });
	hub.publishEvent("sibling", "s", { kind: "ready", at: advisoryNow() });
	expect((await hub.remind({ parentSessionId: "parent", ref: sibling, requestId: "sibling", content: "status" })).outcome).toBe("injected");
	expect((await hub.remind({ parentSessionId: "parent", ref, requestId: "check", content: "status" })).outcome).toBe(
		"injected",
	);
	expect(vi.getTimerCount()).toBe(2);
	hub.disposeHome("w1");
	expect(hub.children("parent")).toHaveLength(1);
	expect(hub.children("parent")[0]?.ref).toEqual(sibling);
	expect(vi.getTimerCount()).toBe(1);
	expect((await hub.remind({ parentSessionId: "parent", ref, requestId: "check", content: "status" })).outcome).toBe(
		"unavailable",
	);
	hub.detach("sibling", "s");
	expect(vi.getTimerCount()).toBe(0);
});

it("rejects stale replies and enforces the already-redacted body cap", async () => {
	const { hub, ref } = fixture();
	const report = JSON.stringify({
		state: "progressing",
		progress: "ok",
		tried: [],
		blocker: "",
		nextAction: "continue",
	});
	hub.detach("child", "c");
	expect(
		(
			await hub.sendBound({
				childSessionId: "child",
				fromAgentId: "Child",
				toAgentId: "Parent",
				assignmentId: ref.assignmentId,
				body: report,
			})
		).outcome,
	).toBe("unavailable");
	const next = fixture();
	expect(
		(
			await next.hub.remind({
				parentSessionId: "parent",
				ref: next.ref,
				requestId: "check",
				content: "x".repeat(4097),
			})
		).outcome,
	).toBe("unavailable");
});

it("emits changed snapshots and stops signals at terminal", () => {
	const { hub, ref } = fixture();
	const events: string[] = [];
	hub.subscribe("parent", event => events.push(event.type));
	hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
	hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
	hub.signal("child", "tool-repeat", 3);
	hub.terminal("child", ref.assignmentId);
	hub.signal("child", "tool-repeat", 3);
	expect(events).toEqual(["snapshot", "signal"]);
});

it("checks every fifteen seconds and sends one follow-up after five minutes", async () => {
	vi.useFakeTimers();
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const session = { deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Parent", displayName: "Parent", kind: "sub", session });
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session });
	const { hub, ref } = fixture();
	const bus = IrcBus.global();
	if (!(bus instanceof IrcBus)) throw new Error("Expected main IRC bus");
	const delivery = spyOn(bus, "deliverBound");
	try {
		expect(
			(await hub.remind({ parentSessionId: "parent", ref, requestId: "timing", content: "status" })).outcome,
		).toBe("injected");
		vi.advanceTimersByTime(14_999);
		expect(delivery).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(delivery).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(299_999);
		vi.advanceTimersByTime(284_999);
		expect(delivery).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(300_000);
		vi.advanceTimersByTime(1);
		expect(delivery).toHaveBeenCalledTimes(2);
		expect(delivery).toHaveBeenLastCalledWith(
			expect.objectContaining({
				checkId: "timing",
				body: "Reply with a JSON ReportInput via irc send for check timing.",
			}),
			expect.anything(),
		);
		vi.advanceTimersByTime(300_000);
		expect(delivery).toHaveBeenCalledTimes(2);
	} finally {
		hub.disposeHome("w1");
		clock.mockRestore();
		delivery.mockRestore();
	}
});

it("rolls back a failed voluntary report and restores reminder timers", async () => {
	vi.useFakeTimers();
	const clock = spyOn(performance, "now").mockReturnValue(0);
	let failParent = true;
	const parent = {
		deliverIrcMessage: async () => {
			if (failParent) throw new Error("handoff failed");
			return "injected";
		},
	} as unknown as AgentSession;
	const child = { deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Parent", displayName: "Parent", kind: "sub", session: parent });
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session: child });
	const { hub, ref } = fixture();
	const report = JSON.stringify({
		state: "progressing",
		progress: "worked",
		tried: [],
		blocker: "",
		nextAction: "continue",
	});
	const reply = {
		childSessionId: "child",
		fromAgentId: "Child",
		toAgentId: "Parent",
		assignmentId: ref.assignmentId,
		body: report,
	};
	try {
		await hub.remind({ parentSessionId: "parent", ref, requestId: "one", content: "status" });
		await hub.remind({ parentSessionId: "parent", ref, requestId: "two", content: "status" });
		expect(vi.getTimerCount()).toBe(2);
		expect((await hub.sendBound(reply)).outcome).toBe("unavailable");
		expect(vi.getTimerCount()).toBe(2);
		failParent = false;
		expect((await hub.sendBound(reply)).outcome).toBe("injected");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		hub.disposeHome("w1");
		clock.mockRestore();
	}
});

it("admits valid reports once and keeps the watch after invalid reports", async () => {
	vi.useFakeTimers();
	const session = { deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Parent", displayName: "Parent", kind: "sub", session });
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session });
	const { hub, ref } = fixture();
	const events: string[] = [];
	hub.subscribe("parent", event => {
		if (event.type === "reply") events.push(event.state);
	});
	try {
		for (const state of ["progressing", "struggling", "stuck", "waiting"]) {
			const checkId = `check-${state}`;
			await hub.remind({ parentSessionId: "parent", ref, requestId: checkId, content: "status" });
			const reply = {
				childSessionId: "child",
				fromAgentId: "Child",
				toAgentId: "Parent",
				assignmentId: ref.assignmentId,
				checkId,
				body: "invalid",
			};
			expect((await hub.sendBound(reply)).outcome).toBe("unavailable");
			reply.body = JSON.stringify({
				state,
				progress: "worked",
				tried: [],
				blocker: state === "progressing" ? "" : "blocked",
				nextAction: "continue",
				requestId: checkId,
			});
			expect((await hub.sendBound(reply)).outcome).toBe("injected");
			expect((await hub.sendBound(reply)).outcome).toBe("duplicate");
			reply.body = reply.body.replace("worked", "changed");
			expect((await hub.sendBound(reply)).outcome).toBe("unavailable");
		}
		expect(events).toEqual(["progressing", "struggling", "stuck", "waiting"]);
	} finally {
		hub.disposeHome("w1");
	}
});

it("validates admitted messages after terminal but rejects them after remint", () => {
	const { hub, ref } = fixture();
	const binding = { ref, branchId: ref.parentBranchId, senderInstanceId: "c", recipientInstanceId: "p" };
	const checks = [{ fromAgentId: "Child", toAgentId: "Parent", binding }];
	expect(hub.validate(checks)).toEqual([true]);
	hub.terminal("child", ref.assignmentId);
	expect(hub.validate(checks)).toEqual([true]);
	hub.wake("child");
	expect(hub.validate(checks)).toEqual([false]);
});

it("retries failed reminders and expires watches on navigation and parking", async () => {
	vi.useFakeTimers();
	const session = { deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Parent", displayName: "Parent", kind: "sub", session });
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session });
	const { hub, ref } = fixture();
	const bus = IrcBus.global();
	if (!(bus instanceof IrcBus)) throw new Error("Expected main IRC bus");
	const delivery = spyOn(bus, "deliverBound");
	delivery.mockResolvedValueOnce({ to: "Child", outcome: "failed" });
	try {
		const input = { parentSessionId: "parent", ref, requestId: "retry", content: "status" };
		expect((await hub.remind(input)).outcome).toBe("unavailable");
		expect(vi.getTimerCount()).toBe(0);
		expect((await hub.remind(input)).outcome).toBe("injected");
		expect((await hub.remind(input)).outcome).toBe("duplicate");
		hub.navigate("parent");
		vi.advanceTimersByTime(15_000);
		expect(vi.getTimerCount()).toBe(0);
		const next = hub.mint({ childSessionId: "child", parentSessionId: "parent", messaging });
		await hub.remind({ ...input, ref: next, requestId: "park" });
		expect(vi.getTimerCount()).toBe(1);
		hub.parkSession("parent");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		hub.disposeHome("w1");
		delivery.mockRestore();
	}
});

it("does not leak a timer when the child rejects a reminder", async () => {
	vi.useFakeTimers();
	const clock = spyOn(performance, "now").mockReturnValue(0);
	let deliveries = 0;
	const child = {
		deliverIrcMessage: async () => {
			deliveries++;
			throw new Error("failed");
		},
	} as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session: child });
	const { hub, ref } = fixture();
	try {
		expect(
			(await hub.remind({ parentSessionId: "parent", ref, requestId: "failed", content: "status" })).outcome,
		).toBe("unavailable");
		expect(vi.getTimerCount()).toBe(0);
		clock.mockReturnValue(300_000);
		vi.advanceTimersByTime(300_000);
		expect(deliveries).toBe(1);
	} finally {
		hub.disposeHome("w1");
		clock.mockRestore();
	}
});

it("evicts the oldest watch to admit a sixty-fifth reminder", async () => {
	vi.useFakeTimers();
	const session = { deliverIrcMessage: async () => "injected" } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session });
	const { hub, ref } = fixture();
	try {
		for (let i = 0; i < 65; i++)
			expect(
				(await hub.remind({ parentSessionId: "parent", ref, requestId: `check-${i}`, content: "status" })).outcome,
			).toBe("injected");
		expect(vi.getTimerCount()).toBe(64);
		expect(
			(await hub.remind({ parentSessionId: "parent", ref, requestId: "check-0", content: "status" })).outcome,
		).toBe("injected");
	} finally {
		hub.disposeHome("w1");
	}
});

it("publishes to child and parent and rejects invalid signal counts", () => {
	const { hub } = fixture();
	const parent: string[] = [];
	const child: string[] = [];
	hub.subscribe("parent", event => parent.push(event.type));
	hub.subscribe("child", event => child.push(event.type));
	hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
	for (const count of [-1, NaN, Infinity, 1.5]) hub.signal("child", "tool-repeat", count);
	hub.signal("child", "tool-repeat", 1);
	expect(parent).toEqual(["snapshot", "signal"]);
	expect(child).toEqual(parent);
});

it("expires an in-flight reminder after navigation and cleans up thrown delivery", async () => {
	vi.useFakeTimers();
	const gate = Promise.withResolvers<void>();
	const child = {
		deliverIrcMessage: async () => {
			await gate.promise;
			return "injected";
		},
	} as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session: child });
	const { hub, ref } = fixture();
	const pending = hub.remind({ parentSessionId: "parent", ref, requestId: "race", content: "status" });
	hub.navigate("parent");
	gate.resolve();
	expect((await pending).outcome).toBe("injected");
	expect(vi.getTimerCount()).toBe(0);
	hub.disposeHome("w1");
});

it("preserves unsupported messaging when following up after navigation", () => {
	const hub = new AdvisoryHub();
	hub.attach({ sessionId: "parent", instanceId: "p", agentId: "Parent" });
	hub.mint({
		childSessionId: "child",
		parentSessionId: "parent",
		messaging: { status: "unsupported", reasons: ["messaging-disabled"] },
	});
	hub.attach({ sessionId: "child", instanceId: "c", agentId: "Child" });
	hub.navigate("parent");
	hub.mintFollowUp("child", "Parent");
	expect(hub.getAssignment("child")?.messaging).toEqual({ status: "unsupported", reasons: ["messaging-disabled"] });
});

it("expires a watch when messaging support is withdrawn", async () => {
	vi.useFakeTimers();
	const clock = spyOn(performance, "now").mockReturnValue(0);
	let deliveries = 0;
	const session = { deliverIrcMessage: async () => { deliveries++; return "injected"; } } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session });
	const hub = new AdvisoryHub();
	hub.attach({ sessionId: "parent", instanceId: "p", agentId: "Parent" });
	const support: { status: "supported" | "unsupported"; reasons?: ["messaging-disabled"] } = { status: "supported" };
	const ref = hub.mint({ childSessionId: "child", parentSessionId: "parent", messaging: support as typeof messaging });
	hub.attach({ sessionId: "child", instanceId: "c", agentId: "Child" });
	try {
		await hub.remind({ parentSessionId: "parent", ref, requestId: "check", content: "status" });
		support.status = "unsupported"; support.reasons = ["messaging-disabled"];
		clock.mockReturnValue(300_000); vi.advanceTimersByTime(300_000);
		expect(deliveries).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	} finally { hub.detach("child", "c"); clock.mockRestore(); }
});

for (const failureAt of [290_000, 300_000]) {
	it(`restores a failed report at ${failureAt}ms without repeating a follow-up`, async () => {
		vi.useFakeTimers();
		const clock = spyOn(performance, "now").mockReturnValue(0);
		let deliveries = 0;
		const child = { deliverIrcMessage: async () => { deliveries++; return "injected"; } } as unknown as AgentSession;
		const parent = { deliverIrcMessage: async () => { throw new Error("failed"); } } as unknown as AgentSession;
		AgentRegistry.global().register({ id: "Child", displayName: "Child", kind: "sub", session: child });
		AgentRegistry.global().register({ id: "Parent", displayName: "Parent", kind: "sub", session: parent });
		const { hub, ref } = fixture();
		try {
			await hub.remind({ parentSessionId: "parent", ref, requestId: "check", content: "status" });
			clock.mockReturnValue(failureAt);
			vi.advanceTimersByTime(failureAt);
			const body = JSON.stringify({ state: "progressing", progress: "worked", tried: [], blocker: "", nextAction: "continue", requestId: "check" });
			expect((await hub.sendBound({ childSessionId: "child", fromAgentId: "Child", toAgentId: "Parent", assignmentId: ref.assignmentId, checkId: "check", body })).outcome).toBe("unavailable");
			clock.mockReturnValue(600_000);
			vi.advanceTimersByTime(310_000);
			expect(deliveries).toBe(2);
		} finally { hub.disposeHome("w1"); clock.mockRestore(); }
	});
}
