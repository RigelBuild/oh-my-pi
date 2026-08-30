/**
 * Shared MCP server reload sequence.
 *
 * A single reconnect-and-rebind path reused by every in-session MCP refresh
 * surface (`/mcp reload`, `/reload-plugins`, config-mutation flows, and the
 * `refresh` tool). Centralizing it keeps those callers from drifting apart —
 * notably the `setMCPPromptCommands([])` clear (so a removed server cannot leave
 * a stale `/server:prompt` command) and the `extensionRoots` pass-through (so an
 * extension-declared server survives a reconnect instead of vanishing until
 * restart).
 */
import { clearCache as clearFsCache } from "../capability/fs";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { MCPLoadResult, MCPManager } from "./manager";

/** Inputs for a shared MCP reload, sourced from the live session/settings. */
export interface ReloadMcpServersOptions {
	/** The manager to disconnect and rediscover against. */
	manager: MCPManager;
	/** Clears the MCP prompt command list before rediscovery repopulates it. */
	setMCPPromptCommands: (commands: LoadedCustomCommand[]) => void;
	/** Rebinds the freshly discovered tools onto the live session. */
	refreshMCPTools: (tools: CustomTool[]) => Promise<void>;
	/** Session-local extension roots so extension-declared servers reconnect. */
	extensionRoots: EffectiveExtensionRoots | undefined;
	/** `mcp.enableProjectConfig` — keeps opted-out project servers from starting. */
	enableProjectConfig: boolean;
	/** `browser.enabled` — mirrors startup's browser-server filter. */
	filterBrowser: boolean;
}

/**
 * Disconnect all MCP servers, then rediscover and reconnect them, rebinding the
 * resulting tools onto the session. Mirrors startup's discovery filters so a
 * reload honors the same opt-outs (`mcp.enableProjectConfig: false`, browser
 * gating) and the same extension roots. Returns the load result so the caller
 * can surface connection errors.
 */
export async function reloadMcpServers(options: ReloadMcpServersOptions): Promise<MCPLoadResult> {
	const { manager } = options;

	// Disconnect all existing servers.
	await manager.disconnectAll();
	// Prompt enrichment is asynchronous. Clear commands before rediscovery so
	// removed/disabled servers cannot leave stale `/server:prompt` entries;
	// newly loaded prompts repopulate them through the manager callback.
	options.setMCPPromptCommands([]);
	// External edits to mcp.json (not via writeMCPConfigFile) otherwise keep
	// stale env/command after reload.
	clearFsCache();

	// Rediscover and connect, mirroring startup's discovery filters.
	const result = await manager.discoverAndConnect({
		enableProjectConfig: options.enableProjectConfig,
		filterExa: true,
		filterBrowser: options.filterBrowser,
		extensionRoots: options.extensionRoots,
	});
	await options.refreshMCPTools(manager.getTools());
	return result;
}
