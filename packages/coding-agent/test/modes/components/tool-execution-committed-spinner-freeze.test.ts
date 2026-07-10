import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	stopSharedSpinnerTicker,
	ToolExecutionComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";

/**
 * Live-region probe mock. The `TranscriptLiveRegionProbe` interface now requires
 * BOTH members, so every mock exposes them; the freeze path only reads
 * `isBlockUncommitted`, but omitting `isBlockInLiveRegion` would no longer type.
 * Getters ignore the `component` arg (a `() => boolean` is assignable to the
 * interface's `(c: Component) => boolean`), so a test can flip the answer
 * mid-run through a closed-over `let`.
 */
interface Probe {
	isBlockInLiveRegion: () => boolean;
	isBlockUncommitted: () => boolean;
}

// Contract under test (Option D2): a RUNNING renderless card (a cotal_dm/
// cotal_send-style card — no custom renderCall/renderResult, not in
// toolRenderers) paints an animated spinner frame via the generic fallback.
// Once its rows commit to immutable native scrollback it must STOP animating so
// the committed copy carries the static `pending` glyph instead of a volatile
// spinner glyph — otherwise history shows the card twice, the second bearing the
// spinner. The freeze is one-way, requires a liveRegion probe, and never fires
// for a card that owns a custom renderer (its pending state is already static).
describe("ToolExecutionComponent committed-spinner freeze (D2)", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		// Nerd preset so `theme.spinnerFrames` is the animated status set (U+F144x
		// range) — distinct from the static `pending` glyph the freeze settles on.
		await initTheme(false, "nerd");
	});

	// The shared spinner ticker (`liveSpinnerBlocks` + `sharedSpinnerTimer`) is
	// module-global. An earlier test file may leak a live block that keeps the
	// ticker armed on a REAL interval, so these fake-timer assertions would
	// observe a pre-existing timer instead of a fresh one. Reset it before each
	// test (mirrors tool-execution-spinner.test.ts).
	beforeEach(() => {
		stopSharedSpinnerTicker();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// This file switches the process-global theme to the nerd preset; restore the
	// default afterward so later test files in the same process (e.g.
	// copy-selector, whose tree layout is glyph-width sensitive) see the theme
	// they expect. Without this the nerd preset leaks and clips their output.
	afterAll(async () => {
		await initTheme();
	});

	function makeComponent(opts: { tool?: AgentTool; probe?: Probe }) {
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ui = { requestRender, requestComponentRender } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"cotal_dm",
			{ to: "Main", text: "hi" },
			opts.probe ? { liveRegion: opts.probe } : {},
			opts.tool,
			ui,
		);
		return { component, requestRender, requestComponentRender };
	}

	function frame(component: ToolExecutionComponent): string {
		return stripVTControlCharacters(component.render(100).join("\n"));
	}

	// A row is spinner-bearing if it contains ANY member of the animated frame
	// set — the exact frame index tracks the wall/perf clock, so match the whole
	// set rather than one glyph.
	function hasSpinnerFrame(text: string): boolean {
		return theme.spinnerFrames.some(f => text.includes(f));
	}

	it("animates the spinner while its rows are uncommitted", () => {
		vi.useFakeTimers();
		const { component } = makeComponent({
			probe: { isBlockInLiveRegion: () => true, isBlockUncommitted: () => true },
		});
		// Streamed arg delta keeps the card partial/live (renderless generic
		// fallback → the pending call consumes the spinner frame).
		component.updateArgs({ to: "Main", text: "still typing" });
		vi.advanceTimersByTime(80);

		expect(hasSpinnerFrame(frame(component))).toBe(true);
	});

	it("freezes the spinner to a static glyph once its rows commit", () => {
		vi.useFakeTimers();
		let uncommitted = true;
		const { component } = makeComponent({
			probe: { isBlockInLiveRegion: () => true, isBlockUncommitted: () => uncommitted },
		});
		component.updateArgs({ to: "Main", text: "typing" });

		// Pre-commit: the spinner ticks like any live renderless card.
		vi.advanceTimersByTime(80);
		expect(hasSpinnerFrame(frame(component))).toBe(true);

		// The rows scroll off-grid and commit to native scrollback. The next tick
		// must observe that and stop animating — this is the core regression: a
		// committed copy that keeps the spinner glyph is the reported double.
		uncommitted = false;
		vi.advanceTimersByTime(80);
		expect(hasSpinnerFrame(frame(component))).toBe(false);
	});

	it("does not freeze a card that has a custom renderer", () => {
		vi.useFakeTimers();
		let uncommitted = true;
		// A custom renderCall routes the pending state through the custom branch —
		// a static label, never an animated frame. Such a card never starts a
		// spinner interval, so the D2 freeze guard (`this.#tool?.renderCall`) is a
		// no-op and the card renders its fixed string unchanged.
		const tool = { renderCall: () => new Text("CUSTOM COTAL CARD", 0, 0) } as unknown as AgentTool;
		const { component } = makeComponent({
			tool,
			probe: { isBlockInLiveRegion: () => true, isBlockUncommitted: () => uncommitted },
		});
		component.updateArgs({ to: "Main", text: "typing" });

		const before = frame(component);
		uncommitted = false;
		vi.advanceTimersByTime(240);
		const after = frame(component);

		expect(after).toBe(before);
		expect(after).toContain("CUSTOM COTAL CARD");
		expect(hasSpinnerFrame(after)).toBe(false);
	});

	it("a card with no liveRegion probe never freezes (standalone-harness safety)", () => {
		vi.useFakeTimers();
		// No probe injected — the standalone-TUI mounting path. The guard
		// `#liveRegion === undefined` returns false, so the card keeps animating
		// forever (it can never learn its rows committed).
		const { component } = makeComponent({});
		component.updateArgs({ to: "Main", text: "typing" });
		vi.advanceTimersByTime(240);

		expect(hasSpinnerFrame(frame(component))).toBe(true);
	});

	it("freeze is one-way — stays frozen even if isBlockUncommitted flips back true", () => {
		vi.useFakeTimers();
		let uncommitted = true;
		const { component } = makeComponent({
			probe: { isBlockInLiveRegion: () => true, isBlockUncommitted: () => uncommitted },
		});
		component.updateArgs({ to: "Main", text: "typing" });

		// Commit → freeze.
		uncommitted = false;
		vi.advanceTimersByTime(80);
		expect(hasSpinnerFrame(frame(component))).toBe(false);

		// The probe now (implausibly) reports the rows uncommitted again. The
		// freeze already cleared the spinner interval, and the one-way
		// `#committedSpinnerFrozen` latch means nothing time-driven re-arms it:
		// advancing well past several tick intervals must leave the card static.
		// Blocks never re-enter the animated state once committed.
		uncommitted = true;
		vi.advanceTimersByTime(240);
		expect(hasSpinnerFrame(frame(component))).toBe(false);
	});
});
