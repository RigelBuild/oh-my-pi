import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resolveAutolearnCaptureTarget } from "@oh-my-pi/pi-coding-agent/autolearn/capture-target";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

describe("autolearn capture role resolution", () => {
	it("returns undefined when no captureRole is configured, so the seat's model is kept", () => {
		const settings = Settings.isolated({});
		expect(resolveAutolearnCaptureTarget(settings, [], Effort.Low)).toBeUndefined();
	});

	it("skips capture and warns when captureRole names a role that is not configured", () => {
		const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({ "autolearn.captureRole": "ghost" });
		expect(resolveAutolearnCaptureTarget(settings, [], Effort.Low)).toBeNull();
		expect(warned).toHaveBeenCalledWith(expect.stringContaining("not a configured role"), { role: "ghost" });
	});

	it("skips capture and warns when the role's model is unavailable", () => {
		const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({ "autolearn.captureRole": "judge" });
		settings.setModelRole("judge", "nowhere/absent-model");
		expect(resolveAutolearnCaptureTarget(settings, [], Effort.Low)).toBeNull();
		expect(warned).toHaveBeenCalledWith(expect.stringContaining("model is unavailable"), expect.any(Object));
	});

	it("uses the thinking level the role names over the seat's level", () => {
		const luna = createMockModel({ id: "luna", provider: "luna" });
		const settings = Settings.isolated({ "autolearn.captureRole": "judge" });
		settings.setModelRole("judge", "luna/luna:high");
		const target = resolveAutolearnCaptureTarget(settings, [luna], Effort.Low);
		expect(target?.model.id).toBe("luna");
		expect(target?.thinkingLevel).toBe(Effort.High);
	});

	it("falls back to the seat's thinking level when the role names none", () => {
		const luna = createMockModel({ id: "luna", provider: "luna" });
		const settings = Settings.isolated({ "autolearn.captureRole": "judge" });
		settings.setModelRole("judge", "luna/luna");
		const target = resolveAutolearnCaptureTarget(settings, [luna], Effort.Medium);
		expect(target?.thinkingLevel).toBe(Effort.Medium);
	});
});
