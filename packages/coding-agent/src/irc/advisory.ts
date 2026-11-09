import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { assignmentLineage } from "../task/assignment-lineage";

/** Live metadata survives record copies but is not serialized into transcripts. */
export const advisoryMessage = Symbol("advisoryMessage");
const dropped = new WeakSet<IrcMessage>();

export function advisoryIsCurrent(msg: IrcMessage): boolean {
	if (!msg.advisoryBinding) return true;
	const registry = AgentRegistry.global();
	const sender = registry.get(msg.from)?.session;
	const recipient = registry.get(msg.to)?.session;
	const reason = sender && recipient
		? assignmentLineage.validateBinding(msg.advisoryBinding, sender.sessionManager.getSessionId(), recipient.sessionManager.getSessionId())
		: "stale-instance";
	if (!reason) return true;
	if (!dropped.has(msg)) {
		dropped.add(msg);
		logger.debug("Dropping stale advisory message", { reason });
	}
	return false;
}
