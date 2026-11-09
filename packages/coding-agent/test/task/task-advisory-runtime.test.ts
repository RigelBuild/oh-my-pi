import { expect, it, spyOn, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AssignmentLineage, assignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import {
	admitTaskAdvisory,
	createTaskAdvisory,
	receiveTaskAdvisory,
} from "@oh-my-pi/pi-coding-agent/task/task-advisory-runtime";

it("emits snapshots only when their values change", () => {
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let emit: (event: AgentSessionEvent) => void = () => {};
	const session = {
		sessionManager: { getSessionId: () => "child" },
		subscribe: (listener: typeof emit) => {
			emit = listener;
			return () => {};
		},
		addDisposer: () => {},
	} as unknown as AgentSession;
	const clock = spyOn(performance, "now").mockReturnValue(10);
	try {
		const events: string[] = [];
		createTaskAdvisory(session, lineage).subscribe(event => events.push(event.type));
		emit({ type: "agent_start" });
		emit({ type: "model_changed" });
		expect(events).toEqual(["snapshot"]);
		clock.mockReturnValue(20);
		emit({ type: "model_changed" });
		expect(events).toEqual(["snapshot"]);
	} finally {
		clock.mockRestore();
	}
});

it("starts a fresh baseline after reassignment", () => {
	const lineage = new AssignmentLineage();
	lineage.attach("parent", "parent-instance");
	const first = lineage.mint("child", "parent");
	lineage.attach("child", "child-instance");
	let emit: (event: AgentSessionEvent) => void = () => {};
	const session = {
		sessionManager: { getSessionId: () => "child" },
		subscribe: (listener: typeof emit) => {
			emit = listener;
			return () => {};
		},
		addDisposer: () => {},
	} as unknown as AgentSession;
	const clock = spyOn(performance, "now").mockReturnValue(0);
	try {
		const advisory = createTaskAdvisory(session, lineage);
		emit({ type: "agent_start" });
		clock.mockReturnValue(100);
		expect(advisory.current()?.wallMs).toBe(100);
		const second = lineage.mint("child", "parent");
		lineage.attach("child", "child-instance");
		expect(advisory.current()).toBeUndefined();
		emit({ type: "agent_start" });
		clock.mockReturnValue(125);
		expect(advisory.current()).toMatchObject({ ref: second, wallMs: 25, workTokens: null });
		expect(second.assignmentId).not.toBe(first.assignmentId);
		let signals = 0;
		advisory.subscribe(event => {
			if (event.type === "signal") signals++;
		});
		advisory.signal("tool-repeat", 3);
		lineage.terminal("child", second.assignmentId);
		advisory.signal("tool-repeat", 3);
		expect(signals).toBe(1);
	} finally {
		clock.mockRestore();
	}
});

it("validates bound reports before consuming a reply watch", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	const lineage = new AssignmentLineage();
	lineage.attach("report-parent", "parent-instance");
	const ref = lineage.mint("report-child", "report-parent");
	lineage.attach("report-child", "child-instance");
	let dispose = () => {};
	const parent = {
		sessionManager: { getSessionId: () => "report-parent" },
		subscribe: () => () => {},
		addDisposer: (fn: () => void) => {
			dispose = fn;
		},
	} as unknown as AgentSession;
	const child = { sessionManager: { getSessionId: () => "report-child" } } as unknown as AgentSession;
	AgentRegistry.global().register({ id: "ReportParent", displayName: "Parent", kind: "sub", session: parent });
	AgentRegistry.global().register({ id: "ReportChild", displayName: "Child", kind: "sub", session: child });
	const send = spyOn(IrcBus.global(), "sendBound").mockResolvedValue({ outcome: "injected" });
	try {
		const advisory = createTaskAdvisory(parent, lineage);
		const replies: Array<{ requestId: string; state: string }> = [];
		advisory.subscribe(event => {
			if (event.type === "reply") replies.push({ requestId: event.requestId, state: event.state });
		});
		const bindingFor = (requestId: string) => ({
			ref,
			branchId: ref.parentBranchId,
			senderInstanceId: "child-instance",
			recipientInstanceId: "parent-instance",
			requestId,
		});
		const reportFor = (state: string, requestId: string, extra: Record<string, unknown> = {}) =>
			JSON.stringify({
				state,
				progress: "worked",
				tried: ["step"],
				blocker: state === "progressing" ? "" : "blocked",
				nextAction: "continue",
				requestId,
				...extra,
			});
		for (const state of ["progressing", "struggling", "stuck", "waiting"]) {
			const requestId = `valid-${state}`;
			await advisory.remind(ref, requestId, "request");
			const binding = bindingFor(requestId);
			const reportBody = reportFor(state, requestId);
			const message = {
				from: "ReportChild",
				to: "ReportParent",
				body: reportBody,
				advisoryBinding: binding,
			};
			expect(admitTaskAdvisory(parent, message, binding)).toBe("accept");
			receiveTaskAdvisory(parent, message as Parameters<typeof receiveTaskAdvisory>[1]);
			expect(JSON.stringify(replies.at(-1))).not.toContain(reportBody);
		}
		expect(replies).toEqual([
			{ requestId: "valid-progressing", state: "progressing" },
			{ requestId: "valid-struggling", state: "struggling" },
			{ requestId: "valid-stuck", state: "stuck" },
			{ requestId: "valid-waiting", state: "waiting" },
		]);
		const unboundMessage = {
			from: "ReportChild",
			to: "ReportParent",
			body: JSON.stringify({ state: "progressing", progress: "ok", tried: [], blocker: "", nextAction: "next" }),
		};
		const unboundBinding = { ...bindingFor("unused"), requestId: undefined };
		const noRuntime = { sessionManager: { getSessionId: () => "report-parent" } } as unknown as AgentSession;
		expect(admitTaskAdvisory(noRuntime, unboundMessage, unboundBinding)).toBe("reject");
		expect(admitTaskAdvisory(child, unboundMessage, unboundBinding)).toBe("reject");

		const invalidReports: Array<[string, string]> = [
			["invalid-json", "not-json"],
			["bad-state", reportFor("unknown", "bad-state")],
			["oversize-string", reportFor("progressing", "oversize-string", { progress: "x".repeat(241) })],
			["too-many-tried", reportFor("progressing", "too-many-tried", { tried: ["1", "2", "3", "4"] })],
			["empty-blocker", reportFor("struggling", "empty-blocker", { blocker: "" })],
			["mismatched-request-id", reportFor("progressing", "mismatched-request-id", { requestId: "other-check" })],
			["oversize-body", `${reportFor("progressing", "oversize-body")}${" ".repeat(4096)}`],
			["null-report-id", reportFor("progressing", "null-report-id", { requestId: null })],
			["unknown-key", reportFor("progressing", "unknown-key", { unexpected: true })],
		];
		for (const [requestId, body] of invalidReports) {
			const checkId = requestId;
			const binding = bindingFor(checkId);
			await advisory.remind(ref, checkId, "request");
			const message = { from: "ReportChild", to: "ReportParent", body, advisoryBinding: binding };
			const before = replies.length;
			expect(admitTaskAdvisory(parent, message, binding)).toBe("reject");
			expect(replies).toHaveLength(before);
			const valid = {
				...message,
				body: reportFor("progressing", checkId),
			};
			expect(admitTaskAdvisory(parent, valid, binding)).toBe("accept");
			receiveTaskAdvisory(parent, valid as Parameters<typeof receiveTaskAdvisory>[1]);
			expect(admitTaskAdvisory(parent, valid, binding)).toBe("duplicate");
			expect(
				admitTaskAdvisory(
					parent,
					{ ...valid, body: reportFor("progressing", checkId, { progress: "changed" }) },
					binding,
				),
			).toBe("reject");
		}
	} finally {
		dispose();
		send.mockRestore();
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
	}
});

it("reattaches a parked parent and expires it on release", async () => {
	vi.useFakeTimers();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const lineage = assignmentLineage;
	const parentId = crypto.randomUUID();
	const childId = crypto.randomUUID();
	const makeParent = () => {
		let disposer = () => {};
		return {
			sessionManager: { getSessionId: () => parentId, getUsageStatistics: () => ({ cost: 0, subagentCost: 0 }) },
			subscribe: () => () => {},
			addDisposer: (fn: () => void) => {
				disposer = fn;
			},
			dispose: async () => {
				disposer();
			},
		} as unknown as AgentSession;
	};
	const parent = makeParent();
	const child = {
		sessionManager: { getSessionId: () => childId },
		deliverIrcMessage: async () => "injected",
	} as unknown as AgentSession;
	registry.register({ id: "ParkParent", displayName: "Parent", kind: "sub", session: parent, status: "idle" });
	registry.register({ id: "ParkChild", displayName: "Child", kind: "sub", parentId: "ParkParent", session: child });
	lineage.attach(parentId, "old");
	const ref = lineage.mint(childId, parentId);
	lineage.attach(childId, "child");
	lifecycle.adopt("ParkParent", {
		idleTtlMs: 0,
		revive: async () => {
			const revived = makeParent();
			lineage.attach(parentId, "new");
			return revived;
		},
	});
	try {
		await lifecycle.park("ParkParent");
		const revived = await lifecycle.ensureLive("ParkParent");
		const advisory = createTaskAdvisory(revived, lineage);
		expect((await advisory.remind(ref, "revived-check", "progress")).outcome).toBe("injected");
		await lifecycle.park("ParkParent");
		expect(vi.getTimerCount()).toBe(0);
		await lifecycle.release("ParkParent");
		expect(vi.getTimerCount()).toBe(0);
		expect(lineage.children(parentId)).toEqual([]);
		expect(await advisory.remind(ref, "expired-check", "progress")).toMatchObject({
			outcome: "unavailable",
			reason: "parent-gone",
		});
	} finally {
		await lifecycle.dispose();
		lineage.disposeSession(childId, "child");
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	}
});
