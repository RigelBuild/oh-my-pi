import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { assignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeBridge() {
	const woken: AgentMessage[][] = [];
	const host = {
		isDisposed: () => false,
		isStreaming: () => false,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
	} as unknown as IrcBridgeHost;
	return { bridge: new IrcBridge(host), woken };
}

describe("IrcBridge wake-relay marking", () => {
	it("wakes a bound advisory without advertising a relay", async () => {
		AgentRegistry.resetGlobalForTests();
		const parentId = crypto.randomUUID();
		const childId = crypto.randomUUID();
		const parent = { sessionManager: { getSessionId: () => parentId } } as unknown as AgentSession;
		const child = { sessionManager: { getSessionId: () => childId } } as unknown as AgentSession;
		const registry = AgentRegistry.global();
		registry.register({ id: "Parent", displayName: "Parent", kind: "sub", session: parent });
		registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Parent", session: child });
		assignmentLineage.attach(parentId, "parent-instance");
		const ref = assignmentLineage.mint(childId, parentId);
		assignmentLineage.attach(childId, "child-instance");
		try {
			const { bridge, woken } = makeBridge();
			const outcome = await bridge.deliver({
				id: "bound",
				from: "Child",
				to: "Parent",
				body: "progress",
				ts: 1,
				advisoryBinding: {
					ref,
					branchId: ref.parentBranchId,
					senderInstanceId: "child-instance",
					recipientInstanceId: "parent-instance",
				},
			});
			expect(outcome).toBe("woken");
			expect(woken).toHaveLength(1);
			const record = woken[0][0] as CustomMessage;
			expect(record.details).toMatchObject({ advisory: true });
			expect(record.content).toContain("No one replies on your behalf");
		} finally {
			assignmentLineage.disposeSession(childId, "child-instance");
			assignmentLineage.disposeSession(parentId, "parent-instance");
			AgentRegistry.resetGlobalForTests();
		}
	});
	it("marks relay messages so the peer never relays them back", async () => {
		const { bridge, woken } = makeBridge();
		const outcome = await bridge.deliver({
			id: "irc-1",
			from: "B",
			to: "A",
			body: "You hang up",
			ts: Date.now(),
			wakeRelay: true,
		});

		expect(outcome).toBe("woken");
		expect(woken).toHaveLength(1);
		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ from: "B", wakeRelay: true });
		// The model-facing card must not promise a relay that will never come.
		expect(record.content).toContain("No one replies on your behalf");
	});

	it("still advertises the stop relay for genuine messages", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({ id: "irc-2", from: "B", to: "A", body: "status?", ts: Date.now() });

		const record = woken[0][0] as CustomMessage;
		expect(record.details).not.toHaveProperty("wakeRelay");
		expect(record.content).toContain("is delivered to");
	});
});
