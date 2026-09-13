/**
 * Print mode writes the final assistant text straight to stdout, so an HTML
 * comment the interactive renderer drops used to reach whatever consumes the
 * pipe. A comment quoted inside code must still survive — the renderer shows it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createTextHarness(text: string): AgentSession {
	let advisorDrainPrepared = false;
	return {
		sessionManager: {
			getHeader: () => undefined,
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
		},
		settings: { get: () => false },
		getLastAssistantMessage: () => ({
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: Date.now(),
		}),
		extensionRunner: undefined,
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		prompt: async () => true,
		setTextOutputCommitted: () => {},
		prepareForHeadlessAdvisorDrain: () => {
			advisorDrainPrepared = true;
		},
		waitForAdvisorCatchup: async () => {
			if (!advisorDrainPrepared) throw new Error("advisor catch-up started before headless delivery was armed");
		},
		dispose: async () => {},
	} as unknown as AgentSession;
}

async function printedStdout(text: string): Promise<string> {
	const writes: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const chunk = args[0];
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
		const cb = args[args.length - 1];
		if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
		return true;
	});
	await runPrintMode(createTextHarness(text), { mode: "text", initialMessage: "hello" });
	return writes.join("");
}

describe("print mode text output", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not print a comment the interactive renderer hides", async () => {
		const out = await printedStdout("the answer <!-- machine marker --> stands");

		expect(out).toContain("the answer  stands");
		expect(out).not.toContain("machine marker");
	});

	it("still prints a comment shown inside a fenced block", async () => {
		const out = await printedStdout("example:\n\n```html\n<!-- kept -->\n```");

		expect(out).toContain("<!-- kept -->");
	});
});
