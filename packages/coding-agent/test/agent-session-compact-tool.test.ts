import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CompactTool } from "@oh-my-pi/pi-coding-agent/tools/compact";
import { TempDir } from "@oh-my-pi/pi-utils";

// A trivial tool the scripted model can pair with `compact` so a single turn
// can carry a SECOND runnable tool call — the agent loop then reports
// `willContinue === true` (mid-loop) at that boundary, which is exactly the
// case the wiring must NOT compact on.
const noopTool: AgentTool = {
	name: "noop",
	label: "Noop",
	description: "Does nothing; keeps the tool loop going for another turn.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text" as const, text: "noop done" }] };
	},
};

/** A stub compaction result so `session.compact` can be spied without a real LLM summary. */
function fakeCompaction(): CompactionResult {
	return { summary: "stub summary", firstKeptEntryId: "kept-1", tokensBefore: 0 };
}

/** Top-level ToolSession stub for constructing the real CompactTool. */
function topLevelToolSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		taskDepth: 0,
	};
}

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

async function createHarness(
	responses: MockResponse[],
	options: { includeCompactTool?: boolean } = {},
): Promise<Harness & { mock: MockModel }> {
	const includeCompactTool = options.includeCompactTool ?? true;
	const tempDir = TempDir.createSync("@pi-compact-tool-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		// Auto-compaction OFF: any compaction we observe must be the one the
		// `compact` tool requested, never a threshold/idle fire.
		"compaction.enabled": false,
		// Real lifecycle tests drive the actual `compact()`; pin the summary
		// method so method selection resolves without a remote/vision path. A
		// too-small session still short-circuits to "Nothing to compact" before
		// any LLM summary call, so no API key is needed.
		"compaction.methodOrder": ["soft"],
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	// The real CompactTool: its result carries `toolName === "compact"` +
	// `details.requested`, which is exactly what the onTurnEnd wiring scans for.
	// A top-level ToolSession stub is enough — the tool only reads taskDepth.
	const compactTool = new CompactTool(topLevelToolSession());
	const tools: AgentTool[] = includeCompactTool ? [noopTool, compactTool as AgentTool] : [noopTool];

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

describe("AgentSession compact tool onTurnEnd wiring", () => {
	it("runs a compaction when a settling turn carries a non-error compact result (e)", async () => {
		const { session } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		// Observable seam (brief-endorsed): spy the public compaction entrypoint so
		// no real LLM summary runs. A call proves #applyRequestedCompaction fired
		// the requested compaction at settle. Removing the onTurnEnd call → 0 calls.
		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("do the thing then compact");

		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("forwards trimmed instructions from the compact result into the compaction (e)", async () => {
		const { session } = await createHarness([
			{
				content: [
					{
						type: "toolCall",
						id: "call_compact",
						name: "compact",
						arguments: { instructions: "  keep the failing test  " },
					},
				],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact with focus");

		// End-to-end trim-carry: execute() trims into details.instructions, and the
		// settle path passes that verbatim to compact(). "\u00a0" defends the trim.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).toHaveBeenCalledWith("keep the failing test");
	});

	it("does NOT compact at mid-loop boundaries; only once at the genuine settle (f)", async () => {
		// Turn 1 emits compact + noop → both run → willContinue true (mid-loop).
		// Turn 2 emits another noop → runs → willContinue true (mid-loop).
		// Turn 3 settles (stop) → willContinue false.
		// The compact result is live in `messages` at ALL THREE boundaries, but the
		// gate must apply it only at the final settle. If the `willContinue === false`
		// guard were removed, #applyRequestedCompaction would fire at every boundary
		// once the compact result exists → 3 calls. Exactly-once proves the gate.
		const { session } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} },
					{ type: "toolCall", id: "call_noop_1", name: "noop", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_noop_2", name: "noop", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact mid-loop then keep working");

		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("does not compact when the compact result is an error result (e: non-error guard)", async () => {
		// Omit the compact tool so the scripted call resolves to a synthetic
		// "Tool compact not found" error result (isError: true). The scan skips
		// error results, so no compaction runs.
		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "call_missing", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			{ includeCompactTool: false },
		);

		const compactSpy = vi.spyOn(session, "compact").mockResolvedValue(fakeCompaction());

		await session.prompt("compact but it errors");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("swallows benign compaction failures at turn settle without throwing (g / 8)", async () => {
		// These are the no-op / already-running cases #applyRequestedCompaction is
		// documented to swallow (regex: nothing to compact | already compacted |
		// too small | already in progress). "Compaction already in progress" also
		// covers the re-entrancy branch (point 8). None may escape the settle path.
		for (const message of [
			"Nothing to compact (session too small)",
			"Already compacted",
			"Compaction already in progress",
		]) {
			const { session } = await createHarness([
				{
					content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			]);
			const compactSpy = vi.spyOn(session, "compact").mockRejectedValue(new Error(message));

			// prompt() must resolve — the benign failure is caught inside the settle
			// hook. If it escaped, the turn would reject.
			await expect(session.prompt("compact then benign failure")).resolves.toBeDefined();
			expect(compactSpy).toHaveBeenCalledTimes(1);
		}
	});

	it("completes the prompt when the real compact() lifecycle runs at settle (no resolved spy)", async () => {
		// The deadlock the P1 review flagged: onTurnEnd is awaited from inside the
		// active agent loop, and compact() aborts that operation (its abort() waits
		// on agent.waitForIdle(), which only resolves once onTurnEnd returns and the
		// loop unwinds). Awaiting compact() inline would hang the prompt forever.
		// Drive the REAL compact() — not a resolved spy — so a regression to the
		// inline await reproduces the hang here instead of hiding behind the spy.
		const { session } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		// Observe the real entrypoint without replacing it, so the actual lifecycle
		// (defer past settle → abort is a no-op → too-small no-op) still executes.
		const compactSpy = vi.spyOn(session, "compact");

		// A pre-fix inline await never resolves, so the prompt would hang; awaiting
		// it directly turns that into a bun:test timeout failure (the per-test
		// timeout below), pinning the regression to this test rather than masking
		// it with a resolved spy. Post-fix the deferred compaction runs after the
		// run unwinds and the prompt settles normally.
		await session.prompt("do the thing then compact");
		await session.waitForIdle();

		// The requested compaction ran for real (session too small → benign no-op,
		// swallowed inside the settle path).
		expect(compactSpy).toHaveBeenCalledTimes(1);
	}, 15_000);

	it("does NOT re-fire compaction on a later prompt that made no compact call (turn-scoped)", async () => {
		// The blocking turn-scoping bug: a compact result that survives the
		// transcript (guaranteed on the too-small no-op path) must not re-trigger
		// compaction on a later, unrelated settle. Prompt 1 requests compaction and
		// no-ops (too small). Prompt 2 makes NO compact call; its settle must not
		// re-consume the stale result. Pre-fix (whole-transcript scan, no consume
		// marker) prompt 2 re-fires → 2 calls. Turn-scoped → exactly 1.
		const { session } = await createHarness([
			// Prompt 1: request compaction.
			{
				content: [{ type: "toolCall", id: "call_compact", name: "compact", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["ONE"], stopReason: "stop" },
			// Prompt 2: a plain noop turn, then a text stop. No compact call.
			{
				content: [{ type: "toolCall", id: "call_noop", name: "noop", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["TWO"], stopReason: "stop" },
		]);

		const compactSpy = vi.spyOn(session, "compact");

		await session.prompt("finish task then compact");
		await session.waitForIdle();
		expect(compactSpy).toHaveBeenCalledTimes(1);

		await session.prompt("now do unrelated work");
		await session.waitForIdle();
		// Still exactly one: the second settle found no request for ITS turn.
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});
});
