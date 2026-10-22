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

	it("periodically refreshes tools and stops after disconnectAll", async () => {
		vi.useFakeTimers();
		const manager = new MCPManager(process.cwd());
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fakeConnection("alpha"));

		const initialToolsLoaded = Promise.withResolvers<void>();
		manager.setOnToolsChanged(() => initialToolsLoaded.resolve());
		try {
			await manager.connectServers({ alpha: CONFIG }, {}, undefined, 0);
			await initialToolsLoaded.promise;
			listTools.mockClear();
			const refreshCompleted = Promise.withResolvers<void>();
			manager.setOnToolsChanged(() => refreshCompleted.resolve());
			const refreshAllTools = vi.spyOn(manager, "refreshAllTools");
			manager.startPeriodicToolRefresh(25);

			vi.advanceTimersByTime(24);
			expect(listTools).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(listTools).toHaveBeenCalledTimes(1);
			await refreshCompleted.promise;

			await manager.disconnectAll();
			refreshAllTools.mockClear();
			vi.advanceTimersByTime(100);
			expect(refreshAllTools).not.toHaveBeenCalled();
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
