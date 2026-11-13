import { AdvisoryHub } from "../../task/advisory-hub";
import type { RpcServe } from "../rpc";
import { rpcSync } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { ADVISORY_HUB_KIND, type AdvisoryHubProtocol } from "./advisory-protocol";
import { RemoteAdvisoryHub } from "./advisory-remote";
import { ignoreSettle, PeerCleanups } from "./support";

const cleanups = new PeerCleanups("advisory");

function serve(peer: WorkerPeer): RpcServe<AdvisoryHub, AdvisoryHubProtocol> {
	return {
		attach: (hub, input) => hub.attachFrom(peer.threadId, input),
		detach: (hub, ...args) => hub.detach(...args),
		branch: (hub, ...args) => hub.branch(...args),
		navigate: (hub, ...args) => hub.navigate(...args),
		mint: (hub, ...args) => hub.mint(...args),
		mintFollowUp: (hub, ...args) => hub.mintFollowUp(...args),
		wake: (hub, ...args) => hub.wake(...args),
		terminal: (hub, ...args) => hub.terminal(...args),
		getAssignment: (hub, ...args) => hub.getAssignment(...args),
		current: (hub, ...args) => hub.current(...args),
		children: (hub, ...args) => hub.children(...args),
		publishEvent: (hub, ...args) => hub.publishEvent(...args),
		signal: (hub, ...args) => hub.signal(...args),
		subscribe: (hub, sessionId, listener) => rpcSync(cleanups.track(peer.threadId, hub.subscribe(sessionId, event => ignoreSettle(listener(event))))),
		remind: (hub, ...args) => hub.remind(...args),
		sendBound: (hub, ...args) => hub.sendBound(...args),
		validate: (hub, ...args) => hub.validate(...args),
	};
}

export const advisoryThreadService: ThreadService = {
	name: "advisory",
	installMain(peer) {
		peer.link.exportClass<AdvisoryHub, AdvisoryHubProtocol>(ADVISORY_HUB_KIND, (value): value is AdvisoryHub => value instanceof AdvisoryHub, serve(peer));
	},
	globals: () => AdvisoryHub.main(),
	onWorkerExit(peer) {
		cleanups.release(peer.threadId);
		AdvisoryHub.main().disposeHome(peer.threadId);
	},
	installWorker(link) {
		link.importClass<RemoteAdvisoryHub, AdvisoryHubProtocol>(ADVISORY_HUB_KIND, remote => new RemoteAdvisoryHub(remote));
	},
	boot(globals) {
		if (!(globals instanceof RemoteAdvisoryHub)) throw new Error("Malformed advisory thread globals");
		AdvisoryHub.installGlobal(globals);
	},
};
