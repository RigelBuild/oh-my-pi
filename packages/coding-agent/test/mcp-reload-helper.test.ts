import { describe, expect, it, vi } from "bun:test";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { reloadMcpServers } from "@oh-my-pi/pi-coding-agent/mcp/reload";

// The shared MCP reload sequence is the single path every in-session refresh
// surface (`/mcp reload`, `/reload-plugins`, the `refresh` tool) funnels
// through. Two contracts it must uphold, both of which a divergent per-caller
// copy has historically dropped:
//   1. Extension roots are threaded into `discoverAndConnect` so
//      extension-declared servers survive the reconnect instead of vanishing
//      until restart.
//   2. The MCP prompt commands are cleared before rediscovery so a removed
//      server cannot leave a stale `/server:prompt` command behind.
function fakeManager(tools: Array<{ name: string }> = []) {
	return {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({
			tools: [],
			errors: new Map<string, string>(),
			connectedServers: [],
			exaApiKeys: [],
		})),
		getTools: vi.fn(() => tools),
	};
}

const roots: EffectiveExtensionRoots = {
	explicit: ["/ext/pkg"],
	mode: "merge",
	configured: [],
	provenance: "session",
} as unknown as EffectiveExtensionRoots;

describe("reloadMcpServers", () => {
	it("threads the session's extension roots into discoverAndConnect", async () => {
		const manager = fakeManager();
		const setMCPPromptCommands = vi.fn();
		const refreshMCPTools = vi.fn(async () => {});

		await reloadMcpServers({
			manager: manager as unknown as MCPManager,
			setMCPPromptCommands,
			refreshMCPTools,
			extensionRoots: roots,
			enableProjectConfig: true,
			filterBrowser: false,
		});

		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({
			enableProjectConfig: true,
			filterExa: true,
			filterBrowser: false,
			extensionRoots: roots,
		});
	});

	it("clears MCP prompt commands before rediscovery and rebinds tools after", async () => {
		const tools = [{ name: "mcp__srv_do" }];
		const manager = fakeManager(tools);
		const order: string[] = [];
		const setMCPPromptCommands = vi.fn(() => order.push("clear"));
		const refreshMCPTools = vi.fn(async () => {
			order.push("rebind");
		});
		manager.discoverAndConnect.mockImplementation(async () => {
			order.push("discover");
			return { tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] };
		});

		await reloadMcpServers({
			manager: manager as unknown as MCPManager,
			setMCPPromptCommands,
			refreshMCPTools,
			extensionRoots: undefined,
			enableProjectConfig: true,
			filterBrowser: false,
		});

		expect(setMCPPromptCommands).toHaveBeenCalledWith([]);
		expect(refreshMCPTools).toHaveBeenCalledWith(tools);
		// Clear must precede rediscovery; rebind follows it.
		expect(order).toEqual(["clear", "discover", "rebind"]);
	});
});
