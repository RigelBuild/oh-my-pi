/**
 * `refresh('settings')` reconciles the tool sets whose EXISTENCE is gated on a
 * boolean setting. The image/speech custom-tool groups were the first two, but
 * `createTools` gates most BUILT-INS the same way — `bash`, `grep`, `glob`,
 * `github`, `debug`, `lsp`, `web_search`, `security_scan`, `ask`, `todo`, the
 * AST pair, `checkpoint`/`rewind`, and the auto-learn pair — each read once at
 * construction and never revisited. So disabling `bash.enabled` on disk and
 * refreshing left the existing Bash tool active and callable, and enabling a
 * tool that was absent at startup could not construct it.
 *
 * The reconcile does NOT migrate live state. A group whose tools own running
 * work is left exactly as it was and its blocker is named, so the caller can
 * stop that work and refresh again; every other group still reconciles in the
 * same pass, because a running bash job is no reason for `grep` to go stale.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function bundledAnthropic(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled anthropic model ${id}`);
	return model as Model<Api>;
}

interface Harness {
	session: AgentSession;
	settingsPath: string;
	dispose: () => Promise<void>;
}

/**
 * `initialConfig` is staged BEFORE construction so the session starts from
 * those values and each test observes a real transition rather than a
 * first-time application. `toolNames` exercises the startup whitelist, which is
 * what must keep a never-granted tool absent across a refresh.
 */
async function makeHarness(initialConfig: string, options?: { toolNames?: string[] }): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-gated-builtins-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	await fs.writeFile(settingsPath, initialConfig);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false },
		}),
		model: bundledAnthropic("claude-sonnet-4-5"),
		disableExtensionDiscovery: true,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		...(options?.toolNames ? { toolNames: options.toolNames } : {}),
	});

	return {
		session,
		settingsPath,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh('settings'): setting-gated built-ins with no live state", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops a disabled built-in from the live tool set", async () => {
		// The serious direction, and the reviewer's case: a tool disabled on disk
		// that stays active is still advertised to the model and still callable.
		const h = await makeHarness("grep:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("grep");

			await fs.writeFile(h.settingsPath, "grep:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("grep");
			// `grep` owns no runtime work, so it can never be the reason a refresh
			// refuses — the pass must be clean.
			expect(result.toolGateRefusals).toBeUndefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("installs a built-in enabled after startup", async () => {
		// `github.enabled` defaults off, so the tool was never constructed; the
		// enable has to build it, not just re-activate a name.
		const h = await makeHarness("github:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("github");

			await fs.writeFile(h.settingsPath, "github:\n  enabled: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).toContain("github");
			// Registered, not merely named: the model has to be able to call it.
			expect(h.session.getToolByName("github")).toBeDefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reconciles each gated built-in independently", async () => {
		// Separate levers: moving one must not disturb another's live state.
		const h = await makeHarness("grep:\n  enabled: true\nglob:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("grep");
			expect(h.session.getEnabledToolNames()).toContain("glob");

			await fs.writeFile(h.settingsPath, "grep:\n  enabled: false\nglob:\n  enabled: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).not.toContain("grep");
			expect(h.session.getEnabledToolNames()).toContain("glob");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("drops both halves of the checkpoint/rewind pair together", async () => {
		// They are one group precisely because a half-set strands the agent: it
		// could checkpoint with no way to rewind, or the reverse.
		const h = await makeHarness("checkpoint:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).toContain("rewind");

			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).not.toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).not.toContain("rewind");
		} finally {
			await h.dispose();
		}
	}, 20_000);
});

describe("AgentSession refresh('settings'): a gated built-in holding live state refuses", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses the checkpoint group while a checkpoint is open, naming the blocker", async () => {
		// An open checkpoint's transcript position is reachable only through
		// `rewind`, so dropping the pair would strand the session past a point it
		// can no longer return to. Refuse and say why.
		const h = await makeHarness("checkpoint:\n  enabled: true\n");
		try {
			h.session.setCheckpointState({
				checkpointMessageCount: 0,
				checkpointEntryId: null,
				startedAt: new Date().toISOString(),
			});

			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			// The settings DID reload; only the tool swap was declined.
			expect(result.settingsChanged).toBe(true);
			const refusals = result.toolGateRefusals ?? [];
			expect(refusals.length).toBe(1);
			expect(refusals[0]?.setting).toBe("checkpoint.enabled");
			expect(refusals[0]?.toolNames).toEqual(["checkpoint", "rewind"]);
			// Named, not a coarse "busy": the caller has to know what to stop.
			expect(refusals[0]?.blocker).toContain("checkpoint");
			// And the tools are genuinely untouched, not half-removed.
			expect(h.session.getEnabledToolNames()).toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).toContain("rewind");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("still reconciles an unrelated group in the same refusing pass", async () => {
		// Granularity: the refusal is scoped to the group that owns the live work.
		// A whole-operation refusal (what a session restart does) would leave
		// `grep` advertised after the operator disabled it.
		const h = await makeHarness("checkpoint:\n  enabled: true\ngrep:\n  enabled: true\n");
		try {
			h.session.setCheckpointState({
				checkpointMessageCount: 0,
				checkpointEntryId: null,
				startedAt: new Date().toISOString(),
			});

			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: false\ngrep:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect((result.toolGateRefusals ?? []).map(refusal => refusal.setting)).toEqual(["checkpoint.enabled"]);
			// Refused.
			expect(h.session.getEnabledToolNames()).toContain("checkpoint");
			// Reconciled anyway.
			expect(h.session.getEnabledToolNames()).not.toContain("grep");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reconciles the checkpoint group once the checkpoint is closed", async () => {
		// The refusal is a "stop the other things and retry" instruction, so the
		// retry has to actually work — otherwise the group is stuck forever.
		const h = await makeHarness("checkpoint:\n  enabled: true\n");
		try {
			h.session.setCheckpointState({
				checkpointMessageCount: 0,
				checkpointEntryId: null,
				startedAt: new Date().toISOString(),
			});
			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).toolGateRefusals).toHaveLength(1);

			// The caller stops the named work. A second refresh sees no on-disk
			// MOVE, so the reconcile has to be driven by an actual settings change
			// to re-run — flip the value away and back.
			h.session.setCheckpointState(undefined);
			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: true\n");
			await h.session.refresh("settings");
			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.toolGateRefusals).toBeUndefined();
			expect(h.session.getEnabledToolNames()).not.toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).not.toContain("rewind");
		} finally {
			await h.dispose();
		}
	}, 30_000);

	it("does not refuse a live group whose setting did not move", async () => {
		// Liveness alone must not block: an unrelated refresh while a checkpoint
		// is open would otherwise report a blocker the caller can do nothing
		// useful about, on every single refresh.
		const h = await makeHarness("checkpoint:\n  enabled: true\ngrep:\n  enabled: true\n");
		try {
			h.session.setCheckpointState({
				checkpointMessageCount: 0,
				checkpointEntryId: null,
				startedAt: new Date().toISOString(),
			});

			// `checkpoint.enabled` stays true; only `grep` moves.
			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: true\ngrep:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.toolGateRefusals).toBeUndefined();
			expect(h.session.getEnabledToolNames()).not.toContain("grep");
			expect(h.session.getEnabledToolNames()).toContain("checkpoint");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("refuses the bash group while a bash command is running, naming the blocker", async () => {
		// Bash is the reviewer's named case and the one that owns real OS work: a
		// foreground command holds an abort controller the tool owns, so removing
		// the tool would orphan it with nothing left to report or cancel it.
		const h = await makeHarness("bash:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("bash");

			// Event-gated on the command's own first byte, so the refresh below
			// happens while it is genuinely mid-flight rather than after a sleep we
			// hope was long enough.
			const started = Promise.withResolvers<void>();
			const finished = h.session.executeBash("echo live; sleep 30", chunk => {
				if (chunk.includes("live")) started.resolve();
			});
			await started.promise;

			await fs.writeFile(h.settingsPath, "bash:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			const refusals = result.toolGateRefusals ?? [];
			expect(refusals.length).toBe(1);
			expect(refusals[0]?.setting).toBe("bash.enabled");
			expect(refusals[0]?.blocker).toContain("bash");
			// Untouched: the running command still has its tool.
			expect(h.session.getEnabledToolNames()).toContain("bash");

			h.session.abortBash();
			await finished.catch(() => {});
		} finally {
			await h.dispose();
		}
	}, 30_000);
});

describe("AgentSession refresh('settings'): a never-granted tool stays absent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not install a built-in the startup whitelist omitted", async () => {
		// The rule the two custom-tool groups already hold, extended to built-ins:
		// a setting flip must never widen a session past the capability it
		// launched with. `github` is absent from the whitelist, so enabling
		// `github.enabled` has to stay a no-op.
		const h = await makeHarness("github:\n  enabled: false\n", { toolNames: ["read", "grep"] });
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("github");

			await fs.writeFile(h.settingsPath, "github:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Neither activated nor even constructed.
			expect(h.session.getEnabledToolNames()).not.toContain("github");
			expect(h.session.getToolByName("github")).toBeUndefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("still reconciles a whitelisted tool on the same session", async () => {
		// Guards the negative above from passing vacuously: the whitelist must
		// filter the reconcile, not disable it.
		const h = await makeHarness("grep:\n  enabled: true\n", { toolNames: ["read", "grep"] });
		try {
			expect(h.session.getEnabledToolNames()).toContain("grep");

			await fs.writeFile(h.settingsPath, "grep:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).not.toContain("grep");
		} finally {
			await h.dispose();
		}
	}, 20_000);
});
