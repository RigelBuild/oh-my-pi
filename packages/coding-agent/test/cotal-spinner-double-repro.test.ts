/**
 * Ground-truth repro for the reported "Cotal message renders twice, 2nd copy
 * prefixed with 󱑋" symptom. Real TUI + VirtualTerminal + TranscriptContainer,
 * drainable scheduler (zero wall-clock), mirroring
 * streaming-output-scrollback.test.ts.
 *
 * Established by grep/source (see
 * ~/notes/oh-my-pi/bugs/tool-card-double-render/findings.md v2):
 *   - 󱑋 = U+F144B = SPINNER_FRAMES.nerd.status[1] — an ANIMATED status-spinner
 *     frame (theme.ts:977). Emitted ONLY by formatStatusIcon("running", theme,
 *     spinnerFrame) (render-utils.ts:159-163). The exact frame index that lands
 *     depends on the animation tick (sharedSpinnerFrame(now)), so this test
 *     detects the WHOLE nerd status-spinner frame set, not just index 1.
 *   - A cotal_dm tool card (renderer===undefined, no renderCall/renderResult)
 *     consumes that spinner via generic #formatToolExecution while
 *     #result===undefined && #isPartial (tool-execution.ts:589-598).
 *   - A running card (#result===undefined) is NOT transcript-finalized
 *     (tool-execution.ts:723). ToolExecutionComponent does NOT implement
 *     getTranscriptBlockSettledRows → declares 0 settled rows
 *     (transcript-container.ts:68-73).
 *
 * FIX VERIFIED (below): despite declaring 0 settled rows, a running cotal card's
 * spinner-frame row enters IMMUTABLE native scrollback when the turn scrolls it
 * off-grid (the TUI's own scroll-off commit, separate from the transcript's
 * declared live-region boundary). The D2 fix (tool-execution.ts
 * #maybeFreezeCommittedSpinner, fired from the spinner setInterval tick) stops
 * the animation the instant the card's row commits, so the committed copy
 * carries the STATIC `pending` glyph (theme.status.pending) instead of an
 * animated spinner frame — no stranded "second copy with the 󱑋 glyph". This
 * repro exercises that freeze through the REAL commit path (the unit suite
 * tool-execution-committed-spinner-freeze.test.ts covers the mocked-probe path
 * deterministically); the freeze fires only when the real setInterval ticks, so
 * the test drives it with fake timers interleaved with the async term.flush().
 *
 * MEASUREMENT: getScrollBuffer() = committed history + active grid concatenated
 * (virtual-terminal.ts:337); committed IMMUTABLE history alone is the first
 * `baseY` rows (getBufferPosition().baseY = cappedBaseY). committedHistory()
 * slices to history so a real duplicate-into-scrollback is distinguished from
 * the single on-grid live card.
 *
 * Matt runs the NERD preset (ghostty + Nerd Font); forced here.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const MARKER = "cotal_dm";

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
};
function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
	};
	return {
		now: () => clock,
		scheduleImmediate(cb) {
			enqueue(cb);
		},
		scheduleRender(cb) {
			const item = enqueue(cb);
			return {
				cancel() {
					item.cancelled = true;
				},
			};
		},
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				const item = queue.shift()!;
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

class StaticBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	setLines(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

const ORIGINAL_ROWS = Object.getOwnPropertyDescriptor(process.stdout, "rows");
function stubStdoutRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

// The set of nerd status-spinner frames (theme.spinnerFrames after nerd preset).
// A committed row bearing ANY of these is a running card frozen into history.
let SPINNER_FRAMES: string[] = [];
function hasSpinnerFrame(row: string): boolean {
	return SPINNER_FRAMES.some(frame => row.includes(frame));
}

// Committed IMMUTABLE history only (excludes the on-grid active viewport).
function committedHistory(term: VirtualTerminal): string[] {
	const { baseY } = term.getBufferPosition();
	return term
		.getScrollBuffer()
		.slice(0, baseY)
		.map(row => Bun.stripANSI(row).trimEnd());
}

describe("cotal tool-card spinner double-render (ground truth, nerd preset)", () => {
	beforeAll(async () => {
		await initTheme(false, "nerd");
		SPINNER_FRAMES = [...theme.spinnerFrames];
	});

	// Restore process-global state this file mutates so it doesn't leak into
	// later test files in the same process: the nerd preset (glyph-width-
	// sensitive layouts clip) and the stubbed stdout row count (height-derived
	// renders truncate).
	afterAll(async () => {
		await initTheme();
		if (ORIGINAL_ROWS) Object.defineProperty(process.stdout, "rows", ORIGINAL_ROWS);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	test("nerd preset exposes a status-spinner frame set including U+F144B", () => {
		expect(SPINNER_FRAMES.length).toBeGreaterThan(0);
		expect(SPINNER_FRAMES.includes("\u{F144B}")).toBe(true);
	});

	// Fix verification (D2): a running cotal card scrolls off-grid and commits;
	// once its row is in immutable native scrollback the spinner freeze fires on
	// the next interval tick, so the committed copy carries the STATIC `pending`
	// glyph — not an animated spinner frame. After the result lands the sealed
	// card renders at the live tail, leaving exactly ONE committed copy, frozen
	// static, with zero spinner-frame rows in history.
	test("running cotal card that scrolls off-grid freezes its spinner so history holds one static card copy", async () => {
		if (process.platform === "win32") return;
		// Fake timers so the spinner's real setInterval (SPINNER_RENDER_INTERVAL_MS
		// = 80ms) — the only place #maybeFreezeCommittedSpinner runs — can be
		// stepped deterministically. The VirtualTerminal's flush() drains real
		// microtasks, so each step interleaves vi.advanceTimersByTime(80) (fires
		// the interval callback) with scheduler.flush() + await term.flush() (drains
		// the resulting render). Zero wall-clock.
		vi.useFakeTimers();
		const rows = 6;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();

		const head = new StaticBlock(["assistant: sending a status DM to the supervisor"]);
		transcript.addChild(head);
		const card = new ToolExecutionComponent(
			MARKER,
			{ to: "mercator", text: "status" },
			{ liveRegion: transcript },
			undefined,
			tui,
			process.cwd(),
		);
		transcript.addChild(card);
		// Trailing block below the still-running card — in the real cotal turn the
		// assistant's trailing text / usage row. It starts EMPTY so the card is
		// initially fully on-grid (uncommitted); growing it scrolls the card off.
		const below = new StaticBlock([]);
		transcript.addChild(below);
		tui.addChild(transcript);

		try {
			tui.start();
			scheduler.flush();
			await term.flush();

			// (a) On-grid: the card animates while uncommitted. Ticking the interval
			// here must NOT freeze it (isBlockUncommitted → true).
			vi.advanceTimersByTime(80);
			tui.requestRender();
			scheduler.flush();
			await term.flush();
			expect(transcript.isBlockUncommitted(card)).toBe(true);
			expect(committedHistory(term).some(r => r.includes(MARKER))).toBe(false);

			// (b) Grow the trailing block one row at a time so the card scrolls
			// off-grid and its row commits to immutable native scrollback. Tick the
			// spinner interval at every step so the freeze fires the instant the row
			// commits — the committed copy settles on the static `pending` glyph
			// before an animated frame can strand itself in history. (Without these
			// ticks the committed copy keeps its spinner glyph — the pre-fix
			// double; confirmed by driving this loop with no advanceTimersByTime.)
			for (let n = 1; n <= 8; n++) {
				below.setLines(Array.from({ length: n }, (_, i) => `trailing line ${i}`));
				below.invalidate();
				transcript.invalidate();
				tui.requestRender();
				scheduler.flush();
				await term.flush();
				vi.advanceTimersByTime(80);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			// The card has committed exactly one row, and the freeze has already
			// settled it static — no spinner frame in immutable history.
			const beforeSeal = committedHistory(term);
			const committedMarkerBeforeSeal = beforeSeal.filter(r => r.includes(MARKER));
			const spinnerBeforeSeal = beforeSeal.filter(hasSpinnerFrame);
			expect(transcript.isBlockUncommitted(card)).toBe(false);
			expect(committedMarkerBeforeSeal.length).toBe(1);
			expect(spinnerBeforeSeal.length).toBe(0);

			// (c) The tool returns. Shrink the trailing block so the sealed card
			// renders at the live tail (excluded from committedHistory): the sole
			// committed copy is the stranded frozen-static one.
			below.setLines([]);
			below.invalidate();
			transcript.invalidate();
			card.updateResult(
				{ content: [{ type: "text", text: "DM sent to mercator." }], details: {}, isError: false },
				false,
			);
			tui.requestRender();
			scheduler.flush();
			await term.flush();

			const afterSeal = committedHistory(term);
			const markerCopies = afterSeal.filter(r => r.includes(MARKER));
			const spinnerCopies = afterSeal.filter(hasSpinnerFrame);

			console.log(
				JSON.stringify({
					committedSpinnerRowsWhileRunning: spinnerBeforeSeal.length,
					afterSeal: {
						markerCopies: markerCopies.length,
						markerRows: markerCopies,
						spinnerCopies: spinnerCopies.length,
						spinnerRows: spinnerCopies,
					},
				}),
			);

			// FIX VERIFIED — the D2 freeze eliminates Matt's symptom through the real
			// commit path:
			// (1) the running card's committed row carries NO spinner frame (the
			//     freeze fired the moment it committed),
			expect(spinnerCopies.length).toBe(0);
			// (2) the card appears in committed history exactly ONCE — one frozen
			//     static copy, no stranded second spinner copy,
			expect(markerCopies.length).toBe(1);
			// (3) and that sole committed copy renders the static `pending` glyph
			//     (theme.status.pending = U+F254 in the nerd preset), the tell that
			//     the spinner was frozen rather than left animating.
			expect(markerCopies[0]!.includes(theme.status.pending)).toBe(true);
		} finally {
			card.stopAnimation();
			tui.stop();
			vi.useRealTimers();
			await term.flush();
		}
	}, 30_000);
});
