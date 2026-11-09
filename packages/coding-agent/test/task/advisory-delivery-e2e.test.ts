import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

it("delivers a child advisory at the next model call after a synchronous task", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "advisory-e2e-"));
	const home = path.join(root, "home");
	const cwd = path.join(home, "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi("test/advisory-delivery-e2e");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(auth);
	const childStarted = Promise.withResolvers<void>();
	const releaseChild = Promise.withResolvers<void>();
	let childCalled = false;
	let childFinished = false;
	const managerContexts: string[] = [];
	vi.spyOn(WaitTool.prototype, "execute").mockImplementation(async () => {
		childStarted.resolve();
		await releaseChild.promise;
		return { content: [{ type: "text", text: "done" }], details: { op: "wait" } };
	});
	const mock = createMockModel({
		handler: context => {
			const text = JSON.stringify(context.messages);
			const tools = context.tools ?? [];
			if (text.includes("child assignment") && !childFinished && tools.some(tool => tool.name === "wait")) {
				if (!childCalled) {
					childCalled = true;
					return { content: [{ type: "toolCall", name: "wait", arguments: {} }] };
				}
				childFinished = true;
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
			}
			if (text.includes("manager assignment") && tools.some(tool => tool.name === "task")) {
				managerContexts.push(text);
				if (managerContexts.length === 1) return { content: [{ type: "toolCall", name: "task", arguments: { context: "Report the result.", tasks: [{ name: "LineageChild", agent: "task", task: "child assignment" }] } }] };
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
			}
			return { content: ["label"] };
		},
	});
	const available = registry.getAvailable.bind(registry);
	vi.spyOn(registry, "getAvailable").mockImplementation(kind => [mock, ...available(kind)]);
	const settings = Settings.isolated({ "async.enabled": false, "task.maxRecursionDepth": 4, "task.agentIdleTtlMs": 0, "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, "todo.reminders": false, "advisor.enabled": false, modelRoles: { default: "mock/mock-model" } });
	let main: AgentSession | undefined;
	try {
		({ session: main } = await createAgentSession({ cwd, authStorage: auth, modelRegistry: registry, model: mock, settings, sessionManager: SessionManager.inMemory(cwd), disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true, cacheWarming: false }));
		const mainId = main.sessionManager.getSessionId();
		const run = runSubprocess({ cwd, artifactsDir, agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", spawns: "*" }, task: "manager assignment", index: 0, id: "LineageManager", parentAgentId: "Main", parentSessionId: mainId, parentBranchId: assignmentLineage.branch(mainId), modelOverride: "mock/mock-model", authStorage: auth, modelRegistry: registry, settings, enableLsp: false, enableMCP: false, enableIrc: true });
		await childStarted.promise;
		const child = AgentRegistry.global().get("LineageManager.LineageChild")?.session;
		if (!child) throw new Error("child session missing");
		const binding = assignmentLineage.getAssignment(child.sessionManager.getSessionId());
		if (!binding) throw new Error("child binding missing");
		const body = "DELAYED_PRIVATE_ADVISORY";
		expect(managerContexts).toHaveLength(1);
		expect((await IrcBus.global().sendBound({ from: "LineageManager.LineageChild", to: "LineageManager", body }, { ref: binding.ref, branchId: binding.branchId, senderInstanceId: binding.instanceId, recipientInstanceId: binding.parentInstanceId })).outcome).toBe("injected");
		expect(managerContexts).toHaveLength(1);
		releaseChild.resolve();
		expect((await run).exitCode).toBe(0);
		expect(managerContexts.length).toBeGreaterThanOrEqual(2);
		expect(managerContexts[1]?.split(body)).toHaveLength(2);
	} finally {
		releaseChild.resolve();
		await AgentLifecycleManager.global().dispose();
		await main?.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis("test/advisory-delivery-e2e");
		auth.close();
		vi.restoreAllMocks();
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	}
}, 30_000);

it("wakes a stranded bound advisory without relaying its body", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "advisory-stranded-"));
	const home = path.join(root, "home");
	const cwd = path.join(home, "work");
	await fs.mkdir(cwd, { recursive: true });
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi("test/advisory-stranded-e2e");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(auth);
	const contexts: string[] = [];
	const mock = createMockModel({ handler: context => { contexts.push(JSON.stringify(context.messages)); return { content: ["acknowledged"] }; } });
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, "todo.reminders": false, "advisor.enabled": false });
	const sessions: AgentSession[] = [];
	try {
		for (let i = 0; i < 3; i++) {
			const { session } = await createAgentSession({ cwd, authStorage: auth, modelRegistry: registry, model: mock, settings, sessionManager: SessionManager.inMemory(cwd), disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true, cacheWarming: false });
			sessions.push(session);
		}
		const [main, manager, child] = sessions;
		if (!main || !manager || !child) throw new Error("sessions missing");
		const agents = AgentRegistry.global();
		agents.register({ id: "Main", displayName: "Main", kind: "main", session: main });
		agents.register({ id: "StrandedManager", displayName: "Manager", kind: "sub", parentId: "Main", session: manager });
		agents.register({ id: "StrandedChild", displayName: "Child", kind: "sub", parentId: "StrandedManager", session: child });
		const managerId = manager.sessionManager.getSessionId();
		const childId = child.sessionManager.getSessionId();
		assignmentLineage.attach(managerId, "stranded-manager");
		const ref = assignmentLineage.mint(childId, managerId);
		assignmentLineage.attach(childId, "stranded-child");
		const binding = assignmentLineage.getAssignment(childId);
		if (!binding) throw new Error("child binding missing");
		const body = "STRANDED_PRIVATE_ADVISORY";
		const send = vi.spyOn(IrcBus.prototype, "send");
		const relay = vi.spyOn(main, "emitIrcRelayObservation");
		// Reproduce the final-poll race: delivery observes streaming, then settle observes idle.
		manager.agent.state.isStreaming = true;
		expect((await IrcBus.global().sendBound({ from: "StrandedChild", to: "StrandedManager", body }, { ref, branchId: binding.branchId, senderInstanceId: binding.instanceId, recipientInstanceId: binding.parentInstanceId })).outcome).toBe("injected");
		manager.agent.state.isStreaming = false;
		send.mockClear();
		expect(manager.isStreaming).toBe(false);
		expect(contexts).toHaveLength(0);
		await manager.abort({ reason: "internal" });
		await manager.waitForIdle();
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.split(body)).toHaveLength(2);
		expect(JSON.stringify(send.mock.calls)).not.toContain(body);
		expect(JSON.stringify(relay.mock.calls)).not.toContain(body);
	} finally {
		for (const session of sessions) await session.dispose();
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis("test/advisory-stranded-e2e");
		auth.close();
		vi.restoreAllMocks();
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	}
}, 30_000);
