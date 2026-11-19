import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { BackgroundWork } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Contract: an extension reads how much background work the process has
 * running through `ctx.getBackgroundWork()`, and hears each change through the
 * `background_work_changed` event exactly once per change. Without these, an
 * extension cannot tell a quiet session from a busy one, and it sees stale or
 * repeated counts.
 */
type WorkEvent = { type: "background_work_changed" } & BackgroundWork;

describe("extension background work", () => {
	let tempDir: TempDir;
	let manager: AsyncJobManager;
	let registry: AgentRegistry;
	let session: AgentSession | undefined;
	let releaseJob: (() => void) | undefined;
	/** Every `background_work_changed` payload the extension received, in order. */
	let events: WorkEvent[] = [];
	/** `ctx.getBackgroundWork()` read inside the handler, paired with each payload. */
	let ctxReads: BackgroundWork[] = [];
	/** Sentinel the test emits through the runner to wait for queued deliveries. */
	let flush: (() => Promise<void>) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-background-work-");
		manager = new AsyncJobManager({});
		registry = new AgentRegistry();
		events = [];
		ctxReads = [];
		flush = undefined;
	});

	afterEach(async () => {
		releaseJob?.();
		releaseJob = undefined;
		await session?.dispose();
		session = undefined;
		await manager.dispose({ timeoutMs: 1_000 });
		tempDir.removeSync();
	});

	async function createSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("background_work_changed", (event, ctx) => {
					events.push(event);
					ctxReads.push(ctx.getBackgroundWork());
				});
				// session_clear is a no-payload event; the test emits it to wait for queued deliveries.
				pi.on("session_clear", () => {});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"background-work",
		);
		// Positional tail, in order: getMemory, settings, localProtocolOptions,
		// getAsyncJobSnapshot, agent, createAnnotations, then getBackgroundWork.
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => session?.getBackgroundWork() ?? { jobs: 0, agents: 0 },
		);
		flush = () => runner.emit({ type: "session_clear" }).then(() => undefined);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			agentRegistry: registry,
			extensionRunner: runner,
		});
		return session;
	}

	/** Wait until every queued background-work delivery has reached the handler. */
	async function settleDeliveries(): Promise<void> {
		if (!flush) throw new Error("Expected a created session");
		await flush();
	}

	it("counts a running async job, reports it, and clears when the job settles", async () => {
		const s = await createSession();
		expect(s.getBackgroundWork()).toEqual({ jobs: 0, agents: 0 });

		const gate = Promise.withResolvers<string>();
		releaseJob = () => gate.resolve("released");
		manager.register("bash", "sleep", () => gate.promise, { id: "job-1", ownerId: "Other" });
		await settleDeliveries();
		expect(events).toEqual([{ type: "background_work_changed", jobs: 1, agents: 0 }]);
		expect(ctxReads).toEqual([{ jobs: 1, agents: 0 }]);

		gate.resolve("done");
		await manager.waitForAll();
		await settleDeliveries();
		expect(events).toEqual([
			{ type: "background_work_changed", jobs: 1, agents: 0 },
			{ type: "background_work_changed", jobs: 0, agents: 0 },
		]);
		expect(ctxReads).toEqual([
			{ jobs: 1, agents: 0 },
			{ jobs: 0, agents: 0 },
		]);
	});

	it("counts a running subagent with no job, reports it, and clears when it goes idle", async () => {
		const s = await createSession();
		registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", session: null, status: "running" });
		await settleDeliveries();
		expect(s.getBackgroundWork()).toEqual({ jobs: 0, agents: 1 });
		expect(events).toEqual([{ type: "background_work_changed", jobs: 0, agents: 1 }]);
		expect(ctxReads).toEqual([{ jobs: 0, agents: 1 }]);
		registry.setStatus("Reviewer", "idle");
		await settleDeliveries();
		expect(s.getBackgroundWork()).toEqual({ jobs: 0, agents: 0 });
		expect(events).toEqual([
			{ type: "background_work_changed", jobs: 0, agents: 1 },
			{ type: "background_work_changed", jobs: 0, agents: 0 },
		]);
		expect(ctxReads).toEqual([
			{ jobs: 0, agents: 1 },
			{ jobs: 0, agents: 0 },
		]);
	});

	it("does not count a subagent twice when a running job already carries its id", async () => {
		const s = await createSession();
		registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", session: null, status: "running" });
		const gate = Promise.withResolvers<string>();
		releaseJob = () => gate.resolve("released");
		manager.register("task", "review", () => gate.promise, { id: "job-2", ownerId: "Other", agentId: "Reviewer" });
		await settleDeliveries();
		expect(s.getBackgroundWork()).toEqual({ jobs: 1, agents: 0 });
		// The payload and the ctx read both show the covered subagent as one job, never two.
		expect(events.at(-1)).toEqual({ type: "background_work_changed", jobs: 1, agents: 0 });
		expect(ctxReads.at(-1)).toEqual({ jobs: 1, agents: 0 });
	});

	it("fires only when a count changes, so a no-op registry update adds no event", async () => {
		await createSession();
		registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", session: null, status: "running" });
		await settleDeliveries();
		expect(events).toHaveLength(1);

		// A metadata update leaves both counts unchanged, so the dedupe must suppress it.
		registry.setHistory("Reviewer", { agent: "Reviewer" });
		await settleDeliveries();
		expect(events).toHaveLength(1);
		expect(ctxReads).toHaveLength(1);
	});

	it("does not count a main or advisor ref, however it is running", async () => {
		const s = await createSession();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({ id: "Advisor", displayName: "Advisor", kind: "advisor", session: null, status: "running" });
		await settleDeliveries();
		expect(s.getBackgroundWork()).toEqual({ jobs: 0, agents: 0 });
		expect(events).toEqual([]);
		expect(ctxReads).toEqual([]);
	});

	it("stops emitting after the session is disposed", async () => {
		const s = await createSession();
		await s.dispose();
		session = undefined;
		registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", session: null, status: "running" });
		await settleDeliveries();
		expect(events).toEqual([]);
	});

	it("counts a subagent whose id equals a job id once, as the job", async () => {
		const s = await createSession();
		registry.register({ id: "job-3", displayName: "Reviewer", kind: "sub", session: null, status: "running" });
		const gate = Promise.withResolvers<string>();
		releaseJob = () => gate.resolve("released");
		manager.register("task", "review", () => gate.promise, { id: "job-3", ownerId: "Other" });
		await settleDeliveries();
		expect(s.getBackgroundWork()).toEqual({ jobs: 1, agents: 0 });
		expect(events.at(-1)).toEqual({ type: "background_work_changed", jobs: 1, agents: 0 });
		expect(ctxReads.at(-1)).toEqual({ jobs: 1, agents: 0 });
	});

	it("the sdk ctx closure reads the live session's background work", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			model,
			disableExtensionDiscovery: true,
			extensions: [
				pi => {
					pi.on("background_work_changed", (_event, ctx) => {
						ctxReads.push(ctx.getBackgroundWork());
					});
					// session_clear is a no-payload event; the test emits it to wait for queued deliveries.
					pi.on("session_clear", () => {});
				},
			],
			agentRegistry: registry,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: ".",
				truncated: false,
				totalLines: 1,
				agentsMdFiles: [],
			},
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = created.session;
		const runner = created.session.extensionRunner;
		if (!runner) throw new Error("Expected the sdk session to own an extension runner");
		registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", session: null, status: "running" });
		// The sdk root owns its own job manager, so this closure reads that root's count, not the test's.
		await runner.emit({ type: "session_clear" });
		expect(ctxReads).toEqual([{ jobs: 0, agents: 1 }]);
	});

	it("drops a notify that arrives after disposal even while its listener is still attached", async () => {
		// Withhold the unsubscribe so the session's job listener stays attached after dispose. Only the
		// #isDisposed guard can then stop a late count change from reaching the extension.
		const realOnJobsChanged = manager.onJobsChanged.bind(manager);
		manager.onJobsChanged = listener => {
			realOnJobsChanged(listener);
			return () => {};
		};
		await createSession();
		manager.onJobsChanged = realOnJobsChanged;
		const gate = Promise.withResolvers<string>();
		releaseJob = () => gate.resolve("released");
		manager.register("bash", "sleep", () => gate.promise, { id: "job-guard", ownerId: "Other" });
		await settleDeliveries();
		expect(events).toEqual([{ type: "background_work_changed", jobs: 1, agents: 0 }]);

		await session?.dispose();
		session = undefined;
		gate.resolve("done");
		await manager.waitForAll();
		await settleDeliveries();
		expect(events).toHaveLength(1);
		expect(ctxReads).toHaveLength(1);
	});
});
