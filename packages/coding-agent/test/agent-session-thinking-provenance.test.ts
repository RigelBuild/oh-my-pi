/**
 * Thinking-level PROVENANCE: which transitions pin the session's thinking level
 * against a later `refresh('settings')`, and which leave it following the
 * configured default.
 *
 * Two paths are covered here because both used to answer that question by
 * writing an UNMARKED receipt, and an unmarked receipt used to mean "pinned":
 *
 *   - Retry-fallback recovery, which moves the level because the model it
 *     failed over to demands a different one. It is automatic, so it must
 *     preserve whatever provenance it found — but it ran through the public
 *     `setThinkingLevel()`, which classifies every call as a user selection.
 *   - A resumed LEGACY transcript, written before either provenance marker
 *     existed. Every startup default and every per-turn `auto` resolution was
 *     unflagged there, so a whole class of older sessions read as pinned.
 *
 * Both provenances are now written positively (`settingsTracking` /
 * `explicitPin`), which is what makes an unmarked entry identifiable as legacy
 * rather than as a choice.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model as Model<Api>;
}

// ===========================================================================
// Thread A — retry-fallback recovery preserves provenance
// ===========================================================================

interface FallbackHarness {
	session: AgentSession;
	settingsPath: string;
	primary: Model<Api>;
	fallback: Model<Api>;
	dispose: () => Promise<void>;
}

/**
 * A session whose default role resolves `primary` at `:low`, with a retry
 * fallback chain onto a DIFFERENT provider's model. The primary always fails
 * with a retryable 503, so one `prompt()` drives the real recovery path —
 * `applyRetryFallbackCandidate` — rather than poking `TurnRecovery` directly.
 *
 * `settings` is file-backed so `refresh('settings')` reloads real bytes; the
 * fallback chain lives in the same file for the same reason.
 */
async function makeFallbackHarness(options: {
	/** Written verbatim as the session's config.yml. */
	config: string;
	/** An explicit user thinking pick applied before the fallback runs. */
	explicitPick?: ThinkingLevel;
}): Promise<FallbackHarness> {
	const tempDir = TempDir.createSync("@pi-thinking-provenance-fallback-");
	const cwd = tempDir.path();
	const primary = bundled("anthropic", "claude-sonnet-4-5");
	const fallback = bundled("openai", "gpt-4o-mini");

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const settingsPath = path.join(cwd, "config.yml");
	await fs.writeFile(settingsPath, options.config);

	const mock = createMockModel();
	const agent = new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, streamOptions) => {
			if (model.provider === primary.provider && model.id === primary.id) {
				mock.push({ throw: "overloaded_error: provider returned error 503" });
			} else {
				mock.push({ content: ["Recovered on the fallback"] });
			}
			return mock.stream(model, context, streamOptions);
		},
	});

	const settings = await Settings.loadIsolated({ cwd, agentDir: cwd });
	const startupLevel = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
	const sessionManager = SessionManager.inMemory(cwd);
	// Reproduce a settings-DERIVED startup, which the SDK path performs and the
	// bare constructor does not: the level plus the receipt saying it came from
	// settings. Without the receipt the branch holds no selection at all, which
	// reads as follows-settings for a different reason and would make the
	// fallback assertions below pass vacuously.
	sessionManager.appendModelChange(`${primary.provider}/${primary.id}`);
	sessionManager.appendThinkingLevelChange(startupLevel, undefined, { settingsTracking: true });
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		thinkingLevel: startupLevel,
	});

	return {
		session,
		settingsPath,
		primary,
		fallback,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

/** Config body shared by the fallback cases: `:low` primary, openai fallback. */
function fallbackConfig(primary: Model<Api>, fallback: Model<Api>, defaultThinking: string): string {
	return [
		"compaction:",
		"  enabled: false",
		`defaultThinkingLevel: ${defaultThinking}`,
		"retry:",
		"  baseDelayMs: 5",
		"  fallbackChains:",
		`    default:`,
		`      - ${fallback.provider}/${fallback.id}`,
		"modelRoles:",
		`  default: ${primary.provider}/${primary.id}`,
		"",
	].join("\n");
}

describe("retry fallback: thinking provenance survives the transition", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps following a changed defaultThinkingLevel after a fallback", async () => {
		// The reviewer's scenario. Nothing here is a thinking selection: the
		// level came from `defaultThinkingLevel`, and the fallback adjusted it
		// automatically. So a later configured move must still take effect.
		const primary = bundled("anthropic", "claude-sonnet-4-5");
		const fallback = bundled("openai", "gpt-4o-mini");
		const h = await makeFallbackHarness({ config: fallbackConfig(primary, fallback, "low") });
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// Drive the REAL recovery path: the primary 503s, so the session fails
			// over onto the chain's fallback model.
			await h.session.prompt("trigger the fallback");
			await h.session.waitForIdle();
			expect(h.session.model?.id).toBe(h.fallback.id);

			// Now the operator edits the configured default and refreshes.
			await fs.writeFile(h.settingsPath, fallbackConfig(primary, fallback, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the fallback's thinking adjustment went through the public
			// `setThinkingLevel()`, which marks every call explicit, so it
			// appended a pin receipt and this read `low` forever.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("still preserves an explicit pick made before the fallback", async () => {
		// The guard against over-reaching: recovery PRESERVES provenance, so a
		// real user pick made before the failover must still outrank a later
		// configured move. Same ablation surface, opposite expectation.
		const primary = bundled("anthropic", "claude-sonnet-4-5");
		const fallback = bundled("openai", "gpt-4o-mini");
		const h = await makeFallbackHarness({ config: fallbackConfig(primary, fallback, "low") });
		try {
			// A REAL user/RPC/selector thinking selection, which records its pin.
			h.session.setThinkingLevel(ThinkingLevel.Minimal);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);

			await h.session.prompt("trigger the fallback");
			await h.session.waitForIdle();
			expect(h.session.model?.id).toBe(h.fallback.id);

			await fs.writeFile(h.settingsPath, fallbackConfig(primary, fallback, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The pin survives the round trip through recovery.
			expect(h.session.configuredThinkingLevel()).not.toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});
});

// ===========================================================================
// Thread B — legacy (unmarked) receipts still follow settings
// ===========================================================================

interface ResumeHarness {
	session: AgentSession;
	settingsPath: string;
	model: Model<Api>;
	dispose: () => Promise<void>;
}

/**
 * Resume a transcript whose thinking receipts were written by `seed`, through
 * the real `createAgentSession` resume path.
 *
 * The prior branch always carries a full user+assistant exchange: persistence
 * is lazy, so the JSONL only materializes once an assistant message lands, and
 * the resume path is only taken for a non-empty branch.
 */
async function makeResumeHarness(options: {
	config: string;
	seed: (manager: SessionManager, model: Model<Api>) => void;
}): Promise<ResumeHarness> {
	const tempDir = TempDir.createSync("@pi-thinking-provenance-resume-");
	const cwd = tempDir.path();
	const model = bundled("anthropic", "claude-sonnet-4-5");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const settingsPath = path.join(cwd, "config.yml");
	await fs.writeFile(settingsPath, options.config);

	const prior = SessionManager.create(cwd, path.join(cwd, "prior"));
	prior.appendModelChange(`${model.provider}/${model.id}`);
	prior.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
	prior.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: model.id,
		content: [{ type: "text", text: "earlier reply" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	// Seeded AFTER the exchange so the receipt is the branch's latest thinking
	// entry — which is the one the classifier reads.
	options.seed(prior, model);
	const sessionFile = prior.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	await prior.close();

	const sessionManager = await SessionManager.open(sessionFile, path.join(cwd, "prior"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager,
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({ cwd, agentDir: cwd }),
		disableExtensionDiscovery: true,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	return {
		session,
		settingsPath,
		model,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

function resumeConfig(model: Model<Api>, defaultThinking: string): string {
	return `compaction:\n  enabled: false\ndefaultThinkingLevel: ${defaultThinking}\nmodelRoles:\n  default: ${model.provider}/${model.id}\n`;
}

describe("resume: legacy thinking receipts still follow settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("follows a changed defaultThinkingLevel through an unmarked startup receipt", async () => {
		// The legacy shape: a concrete level with NEITHER provenance marker,
		// exactly what the old startup path wrote for every session whether or
		// not the user had chosen anything.
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const h = await makeResumeHarness({
			config: resumeConfig(model, "low"),
			seed: manager => {
				manager.appendThinkingLevelChange(ThinkingLevel.Low);
			},
		});
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			await fs.writeFile(h.settingsPath, resumeConfig(h.model, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: provenance was the ABSENCE of `settingsTracking`, so this
			// legacy receipt read as a user pin and the level was frozen for the
			// resumed session's whole life.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("follows settings through an unmarked legacy per-turn auto receipt", async () => {
		// The second legacy shape, and the reason the `model_change` positional
		// rule cannot be reused here: the old auto classifier wrote its per-turn
		// resolutions unflagged and MID-SESSION, so "written after a message"
		// does not indicate a choice for thinking.
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const h = await makeResumeHarness({
			config: resumeConfig(model, "low"),
			seed: manager => {
				manager.appendThinkingLevelChange(ThinkingLevel.Medium, AUTO_THINKING);
			},
		});
		try {
			await fs.writeFile(h.settingsPath, resumeConfig(h.model, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("does NOT follow settings through a marked explicit pin", async () => {
		// The discriminating half: a present-day pin carries the positive
		// marker, and a resume must not re-derive over it. This is what keeps
		// the legacy compatibility read from swallowing real pins.
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const h = await makeResumeHarness({
			config: resumeConfig(model, "low"),
			seed: manager => {
				manager.appendThinkingLevelChange(ThinkingLevel.Minimal, ThinkingLevel.Minimal, { explicitPin: true });
			},
		});
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);

			await fs.writeFile(h.settingsPath, resumeConfig(h.model, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});
});

// `/new` keeps the live thinking selection, so the receipt it writes onto the
// fresh branch must keep that selection's PROVENANCE too. Both markers are
// written positively, so an unmarked carry-over would read as a legacy receipt
// instead — which is exactly what the two cases below discriminate.
describe("newSession: the carried-over thinking receipt keeps its provenance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still follows a changed defaultThinkingLevel after /new", async () => {
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const h = await makeResumeHarness({
			config: resumeConfig(model, "low"),
			seed: manager => {
				manager.appendThinkingLevelChange(ThinkingLevel.Low, undefined, { settingsTracking: true });
			},
		});
		try {
			expect(await h.session.newSession()).toBe(true);

			await fs.writeFile(h.settingsPath, resumeConfig(h.model, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("keeps an explicit pin across /new", async () => {
		const model = bundled("anthropic", "claude-sonnet-4-5");
		const h = await makeResumeHarness({
			config: resumeConfig(model, "low"),
			seed: manager => {
				manager.appendThinkingLevelChange(ThinkingLevel.Minimal, ThinkingLevel.Minimal, { explicitPin: true });
			},
		});
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
			expect(await h.session.newSession()).toBe(true);

			await fs.writeFile(h.settingsPath, resumeConfig(h.model, "high"));
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});
});
