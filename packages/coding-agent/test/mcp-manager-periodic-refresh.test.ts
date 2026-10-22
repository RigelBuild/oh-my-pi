import { afterEach, describe, expect, it, vi } from "bun:test";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";

const CONFIG: MCPStdioServerConfig = { type: "stdio", command: "fake-mcp-server" };

class FakeTransport implements MCPTransport {
	connected = true;

	async request<T>(): Promise<T> {
		throw new Error("Unexpected transport request");
	}

	async notify(): Promise<void> {}

	async close(): Promise<void> {
		this.connected = false;
	}
}

function fakeConnection(name: string): MCPServerConnection {
	return {
		name,
		config: CONFIG,
		transport: new FakeTransport(),
		serverInfo: { name: "fake", version: "1.0.0" },
		capabilities: { tools: {} },
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("MCPManager tool refresh scheduling", () => {
	it("throttles on-demand refresh requests to one per 30 seconds", async () => {
		let now = 1_000;
		const manager = new MCPManager(process.cwd(), null, undefined, undefined, () => now);
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fakeConnection("alpha"));
		const initialToolsLoaded = Promise.withResolvers<void>();
		manager.setOnToolsChanged(() => initialToolsLoaded.resolve());
		try {
			await manager.connectServers({ alpha: CONFIG }, {}, undefined, 0);
			await initialToolsLoaded.promise;
			let refreshCompleted = Promise.withResolvers<void>();
			manager.setOnToolsChanged(() => refreshCompleted.resolve());
			listTools.mockClear();

			manager.requestToolRefresh();
			manager.requestToolRefresh();
			expect(listTools).toHaveBeenCalledTimes(1);
			await refreshCompleted.promise;
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(listTools).toHaveBeenCalledTimes(1);
			now += 30_000;
			refreshCompleted = Promise.withResolvers<void>();
			manager.requestToolRefresh();
			await refreshCompleted.promise;
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(listTools).toHaveBeenCalledTimes(2);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("keeps refreshing across a reload and stops only on stopPeriodicToolRefresh", async () => {
		vi.useFakeTimers();
		const manager = new MCPManager(process.cwd());
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async () => fakeConnection("alpha"));

		let toolsChanged = Promise.withResolvers<void>();
		manager.setOnToolsChanged(() => toolsChanged.resolve());
		try {
			await manager.connectServers({ alpha: CONFIG }, {}, undefined, 0);
			await toolsChanged.promise;
			manager.startPeriodicToolRefresh(25);
			listTools.mockClear();

			toolsChanged = Promise.withResolvers<void>();
			vi.advanceTimersByTime(24);
			expect(listTools).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(listTools).toHaveBeenCalledTimes(1);
			await toolsChanged.promise;

			// `/mcp reload` is disconnectAll + reconnect on the same manager.
			await manager.disconnectAll();
			toolsChanged = Promise.withResolvers<void>();
			await manager.connectServers({ alpha: CONFIG }, {}, undefined, 0);
			await toolsChanged.promise;
			listTools.mockClear();
			toolsChanged = Promise.withResolvers<void>();
			vi.advanceTimersByTime(25);
			expect(listTools).toHaveBeenCalledTimes(1);
			await toolsChanged.promise;

			manager.stopPeriodicToolRefresh();
			listTools.mockClear();
			vi.advanceTimersByTime(100);
			expect(listTools).not.toHaveBeenCalled();
		} finally {
			manager.stopPeriodicToolRefresh();
			await manager.disconnectAll();
		}
	});

	it("keeps a server's tools when a refresh fails", async () => {
		const manager = new MCPManager(process.cwd());
		const listTools = vi
			.spyOn(mcpClient, "listTools")
			.mockResolvedValue([{ name: "get_issue", inputSchema: { type: "object" } }]);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fakeConnection("alpha"));
		const loaded = Promise.withResolvers<void>();
		manager.setOnToolsChanged(() => loaded.resolve());
		try {
			await manager.connectServers({ alpha: CONFIG }, {}, undefined, 0);
			await loaded.promise;
			const before = manager.getTools().map(tool => tool.name);
			expect(before).toHaveLength(1);

			listTools.mockRejectedValueOnce(new Error("Temporary failure in name resolution"));
			await manager.refreshAllTools();
			expect(manager.getTools().map(tool => tool.name)).toEqual(before);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("does not start a periodic timer when the interval is zero", async () => {
		vi.useFakeTimers();
		const manager = new MCPManager(process.cwd());
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fakeConnection("alpha"));

		try {
			await manager.connectServers({ alpha: CONFIG }, {}, undefined, 0);
			listTools.mockClear();
			const refreshAllTools = vi.spyOn(manager, "refreshAllTools");
			manager.startPeriodicToolRefresh(0);

			vi.advanceTimersByTime(100);
			expect(refreshAllTools).not.toHaveBeenCalled();
			expect(listTools).not.toHaveBeenCalled();
		} finally {
			await manager.disconnectAll();
		}
	});
});
