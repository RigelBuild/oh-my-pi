import { describe, expect, it } from "bun:test";
import { formatBackgroundNotice } from "@oh-my-pi/pi-tui/tools/bash";

describe("formatBackgroundNotice", () => {
	it("keeps the top-level wake promise unchanged", () => {
		expect(formatBackgroundNotice("bash-42", 300)).toBe(
			"Backgrounded as job bash-42 (killed once it has run 300s in total; `timeout: 0` disables the deadline); its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no `sleep`, `ps`, `pgrep`, `top`, `pidwait`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.",
		);
		expect(formatBackgroundNotice("bash-42", 300, { subagent: false })).toBe(formatBackgroundNotice("bash-42", 300));
	});

	it("tells a subagent its result arrives only while it runs, and to call wait before it ends", () => {
		for (const timeoutSec of [300, undefined]) {
			const notice = formatBackgroundNotice("bash-42", timeoutSec, { subagent: true });
			expect(notice).not.toContain("wait to be woken");
			expect(notice).not.toMatch(/woken/);
			expect(notice).not.toContain("injected into the conversation");
			expect(notice).toContain("its result arrives only while this run is still live");
			expect(notice).toContain("call `wait`");
			expect(notice).toContain("before you end your turn");
			expect(notice).toContain("Do NOT poll for it");
		}
	});
});
