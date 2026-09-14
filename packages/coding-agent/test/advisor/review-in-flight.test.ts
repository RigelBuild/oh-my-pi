/**
 * The advisor runs with the PRIMARY agent idle -- the default
 * `advisor.syncBacklog: "off"` lets a terminal turn's review outlive it -- so a
 * caller asking whether the session is quiescent cannot observe an active
 * review through the primary agent at all. `AgentSession`'s restart quiescence
 * predicate reads `reviewInFlight` for exactly that reason: `beginDispose()`
 * aborts the request and clears its pending deltas, and the replacement never
 * replays the terminal turn, so an accepted review and its note are lost.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../../src/advisor/runtime";

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

describe("AdvisorRuntime.reviewInFlight", () => {
	it("reports a review that outlives the primary turn, and clears once it settles", async () => {
		const gate = Promise.withResolvers<void>();
		const agent: AdvisorAgent = {
			prompt: async () => {
				await gate.promise;
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => [userMessage("turn one", 1)],
			enqueueAdvice: () => {},
		};
		const runtime = new AdvisorRuntime(agent, host);

		expect(runtime.reviewInFlight).toBe(false);

		// The terminal turn ends; the review starts and keeps running.
		runtime.onTurnEnd();
		await Bun.sleep(0);

		// RED (pre-fix): nothing exposed this, so the restart quiescence check saw
		// an idle session and recycled over the running request.
		expect(runtime.reviewInFlight).toBe(true);

		gate.resolve();
		expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);

		// A wait, not a ban: the refusal has to lift once the review settles.
		expect(runtime.reviewInFlight).toBe(false);
	});
});
