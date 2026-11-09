import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assignmentLineage } from "@oh-my-pi/pi-coding-agent/task/assignment-lineage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

it("binds nested assignments to their immediate parent and invalidates them on navigation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-integration-"));
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
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi("test/assignment-lineage");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(auth);
	let managerCalls = 0;
	const mock = createMockModel({
		handler: context => {
			const text = JSON.stringify(context.messages);
			if (text.includes("manager assignment") && !text.includes("child assignment") && managerCalls++ === 0) {
				return { content: [{ type: "toolCall", name: "task", arguments: { context: "Report the result.", tasks: [{ name: "LineageChild", agent: "task", task: "child assignment" }] } }] };
			}
			if ((context.tools ?? []).some(tool => tool.name === "yield")) {
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
			}
			return { content: ["label"] };
		},
	});
	const available = registry.getAvailable.bind(registry);
	vi.spyOn(registry, "getAvailable").mockImplementation(kind => [mock, ...available(kind)]);
	const settings = Settings.isolated({ "task.maxRecursionDepth": 4, "task.agentIdleTtlMs": 0, "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, "todo.reminders": false, "advisor.enabled": false, modelRoles: { default: "mock/mock-model" } });
	let main: AgentSession | undefined;
	try {
		({ session: main } = await createAgentSession({ cwd, authStorage: auth, modelRegistry: registry, model: mock, settings, sessionManager: SessionManager.inMemory(cwd), disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true, cacheWarming: false }));
		const mainId = main.sessionManager.getSessionId();
		const result = await runSubprocess({ cwd, artifactsDir, agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", spawns: "*" }, task: "manager assignment", index: 0, id: "LineageManager", parentAgentId: "Main", parentSessionId: mainId, parentBranchId: assignmentLineage.branch(mainId), modelOverride: "mock/mock-model", authStorage: auth, modelRegistry: registry, settings, enableLsp: false, enableMCP: false, enableIrc: false });
		expect(result.exitCode).toBe(0);
		const manager = AgentRegistry.global().get("LineageManager")?.session;
		const child = AgentRegistry.global().get("LineageManager.LineageChild")?.session;
		if (!manager || !child) throw new Error("nested sessions were not retained");
		const managerId = manager.sessionManager.getSessionId();
		assignmentLineage.wake(child.sessionManager.getSessionId());
		const binding = assignmentLineage.getAssignment(child.sessionManager.getSessionId());
		if (!binding) throw new Error("missing child binding");
		expect(assignmentLineage.isCurrent(binding.ref, binding.instanceId, binding.branchId)).toBe(true);
		expect(binding.ref.parentSessionId).toBe(managerId);
		expect(assignmentLineage.children(mainId).map(item => item.ref.childSessionId)).toEqual([managerId]);
		expect(assignmentLineage.children(managerId).map(item => item.ref.childSessionId)).toEqual([binding.ref.childSessionId]);
		const entries = manager.sessionManager.getEntries();
		const first = entries[0]?.id;
		if (!first) throw new Error("manager has no navigation target");
		await manager.navigateTree(first);
		expect(assignmentLineage.isCurrent(binding.ref, binding.instanceId, binding.branchId)).toBe(false);
	} finally {
		await AgentLifecycleManager.global().dispose();
		await main?.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis("test/assignment-lineage");
		auth.close();
		vi.restoreAllMocks();
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	}
}, 30_000);
