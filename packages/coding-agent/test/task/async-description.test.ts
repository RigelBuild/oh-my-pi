import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

afterEach(() => vi.restoreAllMocks());

it("updates async guidance when wait or background execution availability changes", async () => {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const settings = Settings.isolated({ "async.enabled": true });
	let waitActive = true;
	const tool = await TaskTool.create({
		cwd: "/tmp/task-async-description",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		isToolActive: (name: string) => name !== "wait" || waitActive,
	} as unknown as ToolSession);
	for (const waitTool of [true, false]) {
		waitActive = waitTool;
		const description = tool.description;
		expect(description).toContain("Results auto-deliver");
		expect(description.includes("Call `wait`")).toBe(waitTool);
	}
	cfgAsyncEnabled.override(settings, false);
	expect(tool.description).not.toContain("Results auto-deliver");
});

it("tells a subagent that results arrive only while its run is live, and to wait before it yields", async () => {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
	const settings = Settings.isolated({ "async.enabled": true });
	const tool = await TaskTool.create({
		cwd: "/tmp/task-async-description",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		isToolActive: () => true,
		taskDepth: 1,
	} as unknown as ToolSession);
	const description = tool.description;
	expect(description).toContain("Results arrive only while this run is live");
	expect(description).toContain("call `wait` on pending jobs before you end your turn");
	expect(description).not.toContain("Results auto-deliver");
	expect(description).not.toContain("Call `wait` to receive");
});
