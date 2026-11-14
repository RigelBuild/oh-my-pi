import { expect, it, spyOn } from "bun:test";
import { AdvisoryHub } from "../../src/task/advisory-hub";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { advisoryThreadService } from "../../src/thread/services/advisory";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { AdvisoryProbe, AdvisoryProbeGlobals } from "../fixtures/advisory-bridge-worker";

it("orders advisory updates and disposes the worker home on exit", async () => {
	AdvisoryHub.resetGlobalForTests();
	const hub = AdvisoryHub.main();
	hub.attach({ sessionId: "parent", instanceId: "p", agentId: "Parent" });
	hub.mint({ childSessionId: "child", parentSessionId: "parent", messaging: { status: "supported" } });
	const ready = Promise.withResolvers<AdvisoryProbe>();
	const probeService: ThreadService = {
		name: "probe",
		globals: (): AdvisoryProbeGlobals => ({ ready: probe => ready.resolve(probe) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/advisory-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, advisoryThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	const originalSubscribe = hub.subscribe.bind(hub);
	const subscribe = spyOn(hub, "subscribe");
	let released = 0;
	subscribe.mockImplementation((id, listener) => {
		const off = originalSubscribe(id, listener);
		return () => {
			released++;
			off();
		};
	});
	const dispose = spyOn(hub, "disposeHome");
	try {
		await worker.ready;
		const probe = await ready.promise;
		await probe.attach();
		await probe.subscribe();
		expect(await probe.ready()).toBeNumber();
		expect(hub.current("child")).toBeDefined();
		await worker.terminate("test exit");
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledWith(worker.threadId);
		expect(released).toBe(1);
		expect(hub.children("parent")).toEqual([]);
	} finally {
		await worker.terminate("test cleanup");
		subscribe.mockRestore();
		dispose.mockRestore();
		AdvisoryHub.resetGlobalForTests();
	}
});
