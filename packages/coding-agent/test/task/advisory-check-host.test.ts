import { describe, expect, test } from "bun:test";
import type { AdvisoryReceipt, AssignmentRef } from "../../src/extensibility/extensions/task-advisory";
import { AdvisoryCheckHost } from "../../src/task/advisory-check-host";
import { AdvisorySnapshotSource } from "../../src/task/advisory-snapshot-source";

const ref: AssignmentRef = { childSessionId: "child", assignmentId: "assignment", parentSessionId: "parent", parentBranchId: "branch" };

function fixture() {
	let now = 0;
	let current = true;
	let nextId = 0;
	let receipt: AdvisoryReceipt = { outcome: "injected" };
	const jobs = new Map<object, { at: number; fn: () => void }>();
	const sent: { text: string; checkId: string }[] = [];
	const source = new AdvisorySnapshotSource();
	source.accept({ kind: "ready", at: 0 });
	const host = new AdvisoryCheckHost({
		now: () => now,
		schedule: (fn, ms) => {
			const key = {};
			jobs.set(key, { at: now + ms, fn });
			return () => { jobs.delete(key); };
		},
		send: async (_child, text, binding) => { sent.push({ text, checkId: binding.checkId }); return receipt; },
		isCurrent: () => current,
		newCheckId: () => `check-${++nextId}`,
		policy: { wallMs: 1_800_000, tokenStep: 100_000, localThresholds: { "edit-repeat": 6, "tool-repeat": 3 }, reminderCooldownMs: 600_000, noReplyMs: 300_000, pollMs: 15_000 },
	});
	return {
		host, source, sent,
		setCurrent: (value: boolean) => { current = value; },
		setReceipt: (value: AdvisoryReceipt) => { receipt = value; },
		observe: (local: { "edit-repeat"?: number; "tool-repeat"?: number } = {}, supported = true) => {
			const snapshot = source.snapshot(now);
			if (!snapshot) throw new Error("source not ready");
			return host.observe(ref, snapshot, local, supported);
		},
		advance: (ms: number) => {
			const end = now + ms;
			while (true) {
				let selected: { key: object; at: number; fn: () => void } | undefined;
				for (const [key, job] of jobs) if (job.at <= end && (!selected || job.at < selected.at)) selected = { key, ...job };
				if (!selected) break;
				now = selected.at;
				jobs.delete(selected.key);
				selected.fn();
			}
			now = end;
		},
	};
}

describe("advisory check host", () => {
	test("observes wall crossings while the child is silent", () => {
		const f = fixture();
		f.host.watch(ref, f.source, () => ({ local: {}, messagingSupported: true }));
		f.advance(1_799_999);
		expect(f.sent).toHaveLength(0);
		f.advance(1);
		expect(f.sent).toHaveLength(1);
		f.host.dispose();
		f.advance(1_800_000);
		expect(f.sent).toHaveLength(1);
	});

	test("coalesces crossings and sends one follow-up at five minutes", async () => {
		const f = fixture();
		f.source.accept({ kind: "assistant-usage", id: "usage", usage: { input: 100_000 } });
		const id = f.observe({ "edit-repeat": 6 });
		expect(f.observe({ "tool-repeat": 3 })).toBe(id);
		await Promise.resolve();
		f.advance(299_999);
		expect(f.sent).toHaveLength(1);
		f.advance(1);
		expect(f.sent).toHaveLength(2);
		f.advance(600_000);
		expect(f.sent).toHaveLength(2);
	});

	test("matching reply closes the timer", async () => {
		const f = fixture();
		const id = f.observe({ "edit-repeat": 6 });
		await Promise.resolve();
		expect(f.host.reply({ assignmentId: ref.assignmentId, checkId: id ?? "" })).toBe(true);
		f.advance(300_000);
		expect(f.sent).toHaveLength(1);
	});

	test("stale assignments suppress delayed follow-up", () => {
		const f = fixture();
		f.observe({ "edit-repeat": 6 });
		f.setCurrent(false);
		f.advance(300_000);
		expect(f.sent).toHaveLength(1);
	});

	test("failed reminder does not reset the existing cooldown", async () => {
		const f = fixture();
		const id = f.observe({ "edit-repeat": 6 });
		await Promise.resolve();
		f.host.reply({ assignmentId: ref.assignmentId, checkId: id ?? "" });
		f.advance(600_000);
		f.setReceipt({ outcome: "unavailable", reason: "handoff-failed" });
		f.observe({ "tool-repeat": 3 });
		await Promise.resolve();
		f.setReceipt({ outcome: "injected" });
		f.advance(1_200_000);
		f.observe();
		expect(f.sent).toHaveLength(3);
	});

	test("unsupported messaging remains armed without a timer", () => {
		const f = fixture();
		expect(f.observe({ "edit-repeat": 6 }, false)).toBeUndefined();
		f.advance(300_000);
		expect(f.sent).toHaveLength(0);
	});
});
