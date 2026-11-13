import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { AdvisoryHub, type AdvisoryCheck } from "../task/advisory-hub";

/** Live metadata survives record copies but is not serialized into transcripts. */
export const advisoryMessage = Symbol("advisoryMessage");

/** Validate all bound messages in one owner-thread read. */
export function currentAdvisories(messages: readonly IrcMessage[]): boolean[] {
	const checks: AdvisoryCheck[] = [];
	for (const message of messages) {
		if (message.advisoryBinding)
			checks.push({ fromAgentId: message.from, toAgentId: message.to, binding: message.advisoryBinding });
	}
	const valid = checks.length ? AdvisoryHub.global().validate(checks) : [];
	let index = 0;
	return messages.map(message => (message.advisoryBinding ? valid[index++] === true : true));
}
