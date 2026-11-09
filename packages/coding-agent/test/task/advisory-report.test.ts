import { expect, it } from "bun:test";
import { parseReportInput } from "@oh-my-pi/pi-coding-agent/task/advisory-report";

function report(state: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		state,
		progress: "worked",
		tried: ["step"],
		blocker: state === "progressing" ? "" : "blocked",
		nextAction: "continue",
		...extra,
	});
}

it("accepts every report state without retaining unrelated data", () => {
	for (const state of ["progressing", "struggling", "stuck", "waiting"]) {
		expect(parseReportInput(report(state), "check-1")).toMatchObject({ state });
	}
});

it("rejects malformed and over-limit reports", () => {
	const invalid = [
		"not-json",
		report("unknown"),
		report("progressing", { progress: "x".repeat(241) }),
		report("progressing", { tried: ["1", "2", "3", "4"] }),
		report("struggling", { blocker: "" }),
		report("progressing", { requestId: "other-check" }),
		report("progressing", { requestId: "é".repeat(65) }),
		report("progressing", { requestId: null }),
		report("progressing", { unexpected: true }),
		`${report("progressing")}${" ".repeat(4096)}`,
	];
	for (const input of invalid) expect(parseReportInput(input, "check-1")).toBeUndefined();
});
