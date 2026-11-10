import { describe, expect, it } from "bun:test";
import { shouldEmulatePageFocus } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { WorkerInitPayload } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";

const headlessPayload = {
	mode: "headless",
	browserWSEndpoint: "ws://localhost:9222",
	safeDir: "/tmp",
	uploadDir: "/tmp/uploads",
} satisfies WorkerInitPayload;

const attachPayload = {
	mode: "attach",
	browserWSEndpoint: "ws://localhost:9222",
	safeDir: "/tmp",
	uploadDir: "/tmp/uploads",
	page: { kind: "borrowed", targetId: "target-1" },
} satisfies WorkerInitPayload;

describe("browser page focus emulation", () => {
	it("always emulates focus for a page it owns", () => {
		expect(shouldEmulatePageFocus(true, headlessPayload)).toBe(true);
		expect(shouldEmulatePageFocus(true, attachPayload)).toBe(true);
	});

	it("emulates a non-owned attached page only when requested", () => {
		expect(shouldEmulatePageFocus(false, { ...attachPayload, emulateFocus: true })).toBe(true);
		expect(shouldEmulatePageFocus(false, { ...attachPayload, emulateFocus: false })).toBe(false);
		expect(shouldEmulatePageFocus(false, attachPayload)).toBe(false);
	});

	it("never emulates focus for a non-owned headless page", () => {
		expect(shouldEmulatePageFocus(false, headlessPayload)).toBe(false);
	});
});
