import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import type { ClientBridge } from "../../src/session/client-bridge";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { advisoryEventOf } from "../../src/task/advisory-session-adapter";
import { AdvisorySnapshotSource } from "../../src/task/advisory-snapshot-source";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function setup(tools: AgentTool[], responses: NonNullable<MockModelOptions["responses"]>) {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ responses });
	const manager = SessionManager.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	return { auth, manager, session };
}
test("overlapping real tool calls close in completion order", async () => {
	const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const ended = Promise.withResolvers<void>();
	const starts = Promise.withResolvers<void>();
	const tools: AgentTool[] = [0, 1].map(index => ({
		name: `tool${index}`,
		label: `tool${index}`,
		description: "controlled",
		parameters: type({}),
		concurrency: "shared",
		async execute() {
			started[index].resolve();
			await releases[index].promise;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	}));
	const { session, auth } = setup(tools, [
		{
			content: [
				{ type: "toolCall", id: "first", name: "tool0", arguments: {} },
				{ type: "toolCall", id: "second", name: "tool1", arguments: {} },
			],
		},
		{ content: ["done"] },
	]);
	const source = new AdvisorySnapshotSource();
	const events: string[] = [];
	let now = 0;
	session.subscribe(event => {
		const mapped = advisoryEventOf(event, now);
		if (mapped) source.accept(mapped);
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			events.push(`${event.type}:${event.toolCallId}`);
			if (event.type === "tool_execution_end" && event.toolCallId === "second") ended.resolve();
			if (events.filter(item => item.startsWith("tool_execution_start:")).length === 2) starts.resolve();
		}
	});
	const run = session.prompt("go");
	try {
		await Promise.all(started.map(item => item.promise));
		await starts.promise;
		now = 10;
		expect(source.snapshot(now)).toMatchObject({ unblockedMs: 0, waitReasons: ["tool"] });
		releases[1].resolve();
		await ended.promise;
		now = 20;
		expect(source.snapshot(now)).toMatchObject({ unblockedMs: 0, waitReasons: ["tool"] });
		releases[0].resolve();
		await run;
		now = 30;
		expect(source.snapshot(now)).toMatchObject({ unblockedMs: 10, waitReasons: [] });
		expect(events).toEqual([
			"tool_execution_start:first",
			"tool_execution_start:second",
			"tool_execution_end:second",
			"tool_execution_end:first",
		]);
	} finally {
		for (const release of releases) release.resolve();
		await run.catch(() => {});
		await session.dispose();
		auth.close();
	}
});
test("denied ACP approval closes the real tool interval", async () => {
	let executed = false;
	const tool: AgentTool = {
		name: "bash",
		label: "bash",
		description: "controlled",
		parameters: type({ "command?": "string" }),
		async execute() {
			executed = true;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const permission = Promise.withResolvers<void>();
	const decision = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission() {
			permission.resolve();
			await decision.promise;
			return { outcome: "selected", optionId: "reject_once", kind: "reject_once" };
		},
	};
	const { session, auth } = setup(
		[tool],
		[
			{ content: [{ type: "toolCall", id: "denied", name: "bash", arguments: { command: "echo hi" } }] },
			{ content: ["done"] },
		],
	);
	session.setClientBridge(bridge);
	const source = new AdvisorySnapshotSource();
	const events: string[] = [];
	let now = 0;
	session.subscribe(event => {
		const mapped = advisoryEventOf(event, now);
		if (mapped) source.accept(mapped);
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			events.push(`${event.type}:${event.toolCallId}`);
			if (event.type === "tool_execution_start") started.resolve();
		}
	});
	const run = session.prompt("go");
	try {
		await permission.promise;
		await started.promise;
		now = 10;
		expect(source.snapshot(now)).toMatchObject({ unblockedMs: 0, waitReasons: ["tool"] });
		decision.resolve();
		await run;
		now = 20;
		expect(source.snapshot(now)).toMatchObject({ unblockedMs: 10, waitReasons: [] });
		expect(events).toEqual(["tool_execution_start:denied", "tool_execution_end:denied"]);
		expect(executed).toBe(false);
	} finally {
		decision.resolve();
		await run.catch(() => {});
		await session.dispose();
		auth.close();
	}
});
test("real persisted assistant usage is counted once by id", async () => {
	const { session, auth, manager } = setup(
		[],
		[{ content: ["done"], usage: { input: 11, output: 7, cacheWrite: 3, cacheRead: 5, totalTokens: 26 } }],
	);
	const source = new AdvisorySnapshotSource();
	const ids: string[] = [];
	session.subscribe(event => {
		const mapped = advisoryEventOf(event, 0);
		if (mapped) source.accept(mapped);
		if (event.type === "message_persisted") {
			ids.push(event.id);
			if (mapped) source.accept(mapped);
		}
	});
	try {
		await session.prompt("hello");
		expect(ids).toHaveLength(1);
		expect(manager.getEntries().some(entry => entry.id === ids[0])).toBe(true);
		expect(source.snapshot(0)).toMatchObject({ workTokens: 21, usagePartial: false });
	} finally {
		await session.dispose();
		auth.close();
	}
});
