import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { assignmentLineage } from "../task/assignment-lineage";

/** Live metadata survives record copies but is not serialized into transcripts. */
export const advisoryMessage = Symbol("advisoryMessage");
const dropped = new WeakSet<IrcMessage>();

export function advisoryBindingFailure(msg: Pick<IrcMessage, "from" | "to" | "advisoryBinding">) {
	if (!msg.advisoryBinding) return undefined;
	const registry = AgentRegistry.global();
	const sender = registry.get(msg.from)?.session;
	const recipient = registry.get(msg.to)?.session;
	return sender && recipient
		? assignmentLineage.validateBinding(msg.advisoryBinding, sender.sessionManager.getSessionId(), recipient.sessionManager.getSessionId())
		: "stale-instance";
}

export function advisoryIsCurrent(msg: IrcMessage): boolean {
	const reason = advisoryBindingFailure(msg);
	if (!reason) return true;
	if (!dropped.has(msg)) {
		dropped.add(msg);
		logger.debug("Dropping stale advisory message", { reason });
	}
	return false;
}
