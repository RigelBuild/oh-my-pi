import { MessagePort, parentPort } from "node:worker_threads";
import { AdvisoryHub, advisoryNow } from "../../src/task/advisory-hub";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { advisoryThreadService } from "../../src/thread/services/advisory";
import { identityThreadService } from "../../src/thread/services/identity";

export interface AdvisoryProbe {
	attach(): Promise<void>;
	ready(): Promise<number | undefined>;
	subscribe(): Promise<void>;
}
export interface AdvisoryProbeGlobals {
	ready(probe: AdvisoryProbe): void;
}
const probeService: ThreadService = {
	name: "probe",
	boot(globals) {
		const ready = (globals as AdvisoryProbeGlobals).ready;
		ready({
			async attach() {
				AdvisoryHub.global().attach({
					sessionId: "child",
					instanceId: "c",
					agentId: "Child",
					home: "forged",
				} as never);
			},
			async ready() {
				const hub = AdvisoryHub.global();
				hub.publishEvent("child", "c", { kind: "ready", at: advisoryNow() });
				return hub.current("child")?.wallMs;
			},
			async subscribe() {
				AdvisoryHub.global().subscribe("parent", () => {});
			},
		});
	},
};
const services = [identityThreadService, agentsThreadService, advisoryThreadService, probeService];
const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");
let handler: ((frame: RpcFrame) => void) | undefined;
port.on("message", (message: unknown) => {
	if (!handler) {
		if (
			typeof message !== "object" ||
			message === null ||
			Reflect.get(message, "type") !== "subagent-worker-init" ||
			!isThreadId(Reflect.get(message, "threadId")) ||
			!(Reflect.get(message, "replyPort") instanceof MessagePort) ||
			!(Reflect.get(message, "counter") instanceof SharedArrayBuffer)
		)
			return;
		const init = message as SubagentWorkerInit;
		setCurrentThreadId(init.threadId);
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: next => {
					handler = next;
					return () => {
						handler = undefined;
					};
				},
			},
			{ name: `${init.threadId}↔main`, sync: { port: init.replyPort, counter: new Int32Array(init.counter) } },
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = { type: "subagent-worker-ready" };
		port.postMessage(ready);
		return;
	}
	if (typeof message === "object" && message !== null && typeof Reflect.get(message, "t") === "string")
		handler(message as RpcFrame);
});
