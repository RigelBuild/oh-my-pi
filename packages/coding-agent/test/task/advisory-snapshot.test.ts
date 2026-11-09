import { describe, expect, test } from "bun:test";
import { AdvisorySnapshotSource, type AdvisoryEvent } from "../../src/task/advisory-snapshot-source";

describe("advisory snapshot source", () => {
	test("starts at readiness and excludes overlapping blocked periods", () => {
		const source = new AdvisorySnapshotSource();
		source.accept({ kind: "blocked-start", at: 0, token: "early", reason: "tool" });
		source.accept({ kind: "assistant-usage", id: "early", usage: { input: 99 } });
		expect(source.snapshot(90)).toBeUndefined();
		source.accept({ kind: "ready", at: 100 });
		source.accept({ kind: "blocked-start", at: 150, token: "tool", reason: "tool" });
		source.accept({ kind: "blocked-start", at: 170, token: "approval", reason: "approval" });
		source.accept({ kind: "blocked-end", at: 200, token: "tool" });
		expect(source.snapshot(230)).toMatchObject({
			wallMs: 130,
			unblockedMs: 50,
			waitReasons: ["approval"],
			workTokens: null,
		});
		source.accept({ kind: "blocked-end", at: 230, token: "approval" });
		expect(source.snapshot(250)).toMatchObject({ wallMs: 150, unblockedMs: 70, waitReasons: [] });
	});

	test("counts each id once, excludes cache reads, and reload matches live", () => {
		const events: AdvisoryEvent[] = [
			{ kind: "ready", at: 100 },
			{ kind: "assistant-usage", id: "one", usage: { input: 10, output: 3, cacheWrite: 2, cacheRead: 999 } },
			{ kind: "assistant-usage", id: "one", usage: { input: 10, output: 3, cacheWrite: 2, cacheRead: 999 } },
			{ kind: "blocked-start", at: 120, token: "wait", reason: "wait" },
			{ kind: "blocked-end", at: 140, token: "wait" },
			{ kind: "assistant-usage", id: "two", usage: { input: 2, output: 1, cacheWrite: 0 } },
		];
		const live = new AdvisorySnapshotSource();
		for (const event of events) live.accept(event);
		const restored = new AdvisorySnapshotSource();
		restored.reload(events);
		expect(live.snapshot(200)).toMatchObject({ wallMs: 100, unblockedMs: 80, workTokens: 18, usagePartial: false });
		expect(restored.snapshot(200)).toEqual(live.snapshot(200));
		restored.reload(events);
		restored.accept(events[1]);
		expect(restored.snapshot(200)).toEqual(live.snapshot(200));
	});

	test("marks missing and all-zero usage partial", () => {
		const source = new AdvisorySnapshotSource();
		source.accept({ kind: "ready", at: 0 });
		expect(source.snapshot(0)).toMatchObject({ workTokens: null, usagePartial: true });
		source.accept({ kind: "assistant-usage", id: "missing", usage: undefined });
		source.accept({ kind: "assistant-usage", id: "zero", usage: { input: 0, output: 0, cacheWrite: 0 } });
		source.accept({ kind: "assistant-usage", id: "valid", usage: { input: 3, output: 1 } });
		expect(source.snapshot(0)).toMatchObject({ workTokens: 4, usagePartial: true });
	});

	test("disables work-token accounting for total-only usage", () => {
		const source = new AdvisorySnapshotSource();
		source.accept({ kind: "ready", at: 0 });
		source.accept({ kind: "assistant-usage", id: "valid", usage: { input: 4 } });
		source.accept({ kind: "assistant-usage", id: "total", usage: { total: 40, cacheRead: 5 } });
		expect(source.snapshot(0)).toMatchObject({ workTokens: null, usagePartial: true });
	});
});
