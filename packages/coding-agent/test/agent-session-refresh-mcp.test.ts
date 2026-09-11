/**
 * `AgentSession.refresh('mcp')` MCP reconnect path, driven through the real
 * session so it defends two contracts:
 *
 *   - The session's extension roots are threaded into `discoverAndConnect`, so
 *     extension-declared MCP servers survive the reconnect instead of vanishing
 *     until restart (pre-fix, the session called discoverAndConnect WITHOUT
 *     extensionRoots).
 *   - The plain refresh serialization still runs its happy path after the dead
 *     restart-latch layer was removed: sequential and overlapping refreshes both
 *     complete and reconnect.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const roots: EffectiveExtensionRoots = {
	explicit: ["/ext/pkg"],
	mode: "merge",
	configured: [],
	provenance: "session",
} as unknown as EffectiveExtensionRoots;

function fakeManager() {
	return {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({
			tools: [],
			errors: new Map<string, string>(),
			connectedServers: [],
			exaApiKeys: [],
		})),
		getTools: vi.fn(() => []),
		setNotificationsEnabled: vi.fn((_enabled: boolean) => {}),
		setCwd: vi.fn((_cwd: string) => {}),
	};
}

describe("AgentSession.refresh('mcp')", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		MCPManager.setInstance(undefined);
		vi.restoreAllMocks();
	});

	async function makeSession(mcpManager?: MCPManager, options: { owned?: boolean } = {}): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		// A top-level session OWNS its manager: the SDK wires
		// `disconnectOwnedMcpManager` only for a manager this session created, and
		// the MCP refresh branch gates on that ownership signal. A subagent that
		// merely inherits its parent's manager leaves it undefined.
		const owned = options.owned ?? true;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager,
			disconnectOwnedMcpManager: owned && mcpManager ? async () => {} : undefined,
		});
		sessions.push(session);
		return session;
	}

	it("threads the session's extension roots into MCP rediscovery", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		// Pre-fix: refresh called discoverAndConnect WITHOUT extensionRoots, so
		// extension-declared servers were dropped on reconnect.
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({ extensionRoots: roots });
	});

	// Startup does not pass the raw `browser.enabled` setting to discovery: it
	// passes `shouldFilterBrowserMCPForPrelude(...)`, which additionally requires
	// the callable browser prelude to be reachable (`eval` registered AND active).
	// This session has an EMPTY tool registry, so no prelude exists — filtering
	// browser MCP servers here would strip browser automation with nothing to
	// replace it, leaving the session worse off after a refresh than before.
	it("filters browser MCP servers only when the callable prelude is available", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);
		session.settings.set("browser.enabled", true);

		await session.refresh("mcp");

		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		// Pre-fix this was `true` (the bare setting), dropping the servers even
		// though `eval` is not registered so no prelude replaces them.
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({ filterBrowser: false });
	});

	it("refreshes THIS session's own manager, not the process-global instance()", async () => {
		// Two top-level sessions with distinct managers. The process-global
		// instance() points at session B's manager (the last setInstance wins),
		// but refreshing session A must reconnect A's own manager.
		const managerA = fakeManager();
		const managerB = fakeManager();
		const sessionA = await makeSession(managerA as unknown as MCPManager);
		MCPManager.setInstance(managerB as unknown as MCPManager);

		await sessionA.refresh("mcp");

		// Pre-fix (refresh read MCPManager.instance()), session B's manager was
		// reconnected — disconnecting B's servers — and A's was untouched.
		expect(managerA.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(managerB.discoverAndConnect).not.toHaveBeenCalled();
		expect(managerB.disconnectAll).not.toHaveBeenCalled();
	});

	it("syncs mcp.notifications onto this session's manager on a settings refresh", async () => {
		const tempDir = TempDir.createSync("@pi-refresh-mcp-notif-");
		const settingsPath = `${tempDir.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "mcp:\n  notifications: false\n");
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const manager = fakeManager();
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager as unknown as MCPManager,
		});
		sessions.push(session);

		// Flip notifications false->true on disk, then refresh settings.
		await fsp.writeFile(settingsPath, "mcp:\n  notifications: true\n");
		await session.refresh("settings");

		// Pre-fix: reloading Settings never called setNotificationsEnabled, so
		// the manager kept its stale flag and servers stayed unsubscribed.
		expect(manager.setNotificationsEnabled).toHaveBeenCalledWith(true);
		await tempDir.remove();
	});

	it("surfaces per-server reconnect errors instead of reporting unconditional success", async () => {
		const manager = fakeManager();
		manager.discoverAndConnect = vi.fn(async (_options?: unknown) => ({
			tools: [],
			errors: new Map<string, string>([["broken-server", "ECONNREFUSED"]]),
			connectedServers: [],
			exaApiKeys: [],
		}));
		const session = await makeSession(manager as unknown as MCPManager);

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		// Pre-fix: refresh discarded the MCPLoadResult and never populated
		// mcpErrors, so a failed reconnect reported plain "MCP reconnected".
		expect(result.mcpErrors).toBeInstanceOf(Map);
		expect(result.mcpErrors?.get("broken-server")).toBe("ECONNREFUSED");
	});

	it("leaves mcpErrors unset when every server reconnects", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		expect(result.mcpErrors).toBeUndefined();
	});

	it("runs sequential and overlapping refreshes to completion (no dead restart latch)", async () => {
		const manager = fakeManager();
		const session = await makeSession(manager as unknown as MCPManager);

		// Sequential.
		expect((await session.refresh("mcp")).mcp).toBe(true);
		expect((await session.refresh("mcp")).mcp).toBe(true);

		// Overlapping: both serialize onto the tail and both resolve to a real
		// reconnect result — never a `refused` refusal (the removed latch).
		const [a, b] = await Promise.all([session.refresh("mcp"), session.refresh("mcp")]);
		expect(a.mcp).toBe(true);
		expect(b.mcp).toBe(true);
		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(4);
	});

	it("does not disconnect or rediscover an inherited (parent's) manager", async () => {
		// A subagent granted the `refresh` tool inherits its parent's live
		// manager (SDK passes `mcpManager` but no `disconnectOwnedMcpManager`).
		// `refresh('mcp')` on that child must NOT touch the shared manager: it
		// would interrupt concurrent parent calls and replace the parent's MCP
		// configuration with the child's settings/extension scope.
		const inherited = fakeManager();
		const child = await makeSession(inherited as unknown as MCPManager, { owned: false });

		const result = await child.refresh("mcp");

		// Pre-fix (branch ran for any non-null manager), the shared manager was
		// disconnected and rediscovered under the child's scope.
		expect(inherited.disconnectAll).not.toHaveBeenCalled();
		expect(inherited.discoverAndConnect).not.toHaveBeenCalled();
		expect(result.mcp).toBeUndefined();
		// Nor may the child REPOINT the shared manager's discovery cwd. The
		// repoint runs on every scope, ahead of `settings.reload()`, so without
		// the ownership gate a subagent whose cwd differs from its parent's would
		// silently aim the parent's MCP discovery — and its browser-filter
		// reconcile — at the child's directory.
		expect(inherited.setCwd).not.toHaveBeenCalled();

		// A session that OWNS its manager still refreshes it.
		const owned = fakeManager();
		const top = await makeSession(owned as unknown as MCPManager);
		expect((await top.refresh("mcp")).mcp).toBe(true);
		expect(owned.discoverAndConnect).toHaveBeenCalledTimes(1);
	});

	// A live session can MOVE project (`/move`, a cross-project resume):
	// `SessionManager` and `Settings` are repointed, but the owned `MCPManager`
	// captured its discovery cwd at construction. So a reconnect disconnected the
	// CURRENT project's servers and then reloaded `.mcp.json` from the ORIGINAL
	// one, respawning the old project's stdio commands.
	it("reloads MCP config from the session's CURRENT directory after a move", async () => {
		const origin = TempDir.createSync("@pi-refresh-mcp-origin-");
		const moved = TempDir.createSync("@pi-refresh-mcp-moved-");
		// A REAL manager, so the cwd its config loader receives is the one
		// discovery would actually read — a stubbed `setCwd` could not show that.
		const loadedFrom: string[] = [];
		const manager = new MCPManager(origin.path(), null, async cwd => {
			loadedFrom.push(cwd);
			return { configs: {}, exaApiKeys: [], sources: {} };
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const sessionManager = SessionManager.inMemory(origin.path());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// Guard the premise: before any move, discovery reads the origin.
		expect((await session.refresh("mcp")).mcp).toBe(true);
		expect(loadedFrom).toEqual([origin.path()]);

		// `/move` relocates the session: SessionManager's cwd is the new project.
		sessionManager.setCwdWithoutRelocation(moved.path());

		expect((await session.refresh("mcp")).mcp).toBe(true);

		// Pre-fix this was the ORIGIN again — the manager's constructor-time cwd —
		// so the destination project's servers never loaded and the source
		// project's stdio commands were respawned.
		expect(loadedFrom).toEqual([origin.path(), moved.path()]);

		await origin.remove();
		await moved.remove();
	});

	// The ordering half of the same bug, and the one the `mcp`-scope test above
	// cannot reach: `refresh('settings')` never enters the MCP reconnect block,
	// but `settings.reload()` emits `browser.enabled` synchronously and the
	// eval-prelude listener answers it by calling
	// `MCPManager.reconcileBrowserFilter`, which loads the MCP configuration
	// itself. With the cwd repoint living inside the reconnect block, that load
	// ran against the manager's CONSTRUCTION-time cwd — so on a moved session a
	// browser-prelude enablement flip read the PREVIOUS project's `.mcp.json`
	// and connected its stdio browser servers.
	it("reconciles the browser filter from the CURRENT directory on a settings refresh after a move", async () => {
		const origin = TempDir.createSync("@pi-refresh-mcp-browser-origin-");
		const moved = TempDir.createSync("@pi-refresh-mcp-browser-moved-");
		// The reload must see `browser.enabled` genuinely MOVE, so the value comes
		// from the on-disk config layer rather than an override.
		const settingsPath = `${origin.path()}/config.yml`;
		await fsp.writeFile(settingsPath, "browser:\n  enabled: true\n");
		const settings = await Settings.loadIsolated({ cwd: origin.path(), agentDir: origin.path() });
		// A REAL manager, so the cwd its config loader receives is the one the
		// browser reconcile would actually read.
		const loadedFrom: string[] = [];
		const manager = new MCPManager(origin.path(), null, async cwd => {
			loadedFrom.push(cwd);
			return { configs: {}, exaApiKeys: [], sources: {} };
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const sessionManager = SessionManager.inMemory(origin.path());
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
			// The same wiring sdk.ts installs: this is the hook the eval-prelude
			// listener calls, and the reason a settings reload can reach MCP
			// config loading without any `mcp`-scope refresh.
			reconcileBrowserMcpFilter: async enabled => {
				await manager.reconcileBrowserFilter(enabled);
				return manager.getTools();
			},
		});
		sessions.push(session);

		// `/move` relocates the session: SessionManager's cwd is the new project.
		sessionManager.setCwdWithoutRelocation(moved.path());
		// Turning the browser prelude OFF is the severe direction: the reconcile
		// CONNECTS the browser servers it finds, so reading the wrong project's
		// config spawns that project's stdio commands.
		await fsp.writeFile(settingsPath, "browser:\n  enabled: false\n");

		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix `loadedFrom` was `[origin]`: the listener fired before the
		// reconnect block's `setCwd`, which a `settings` scope never runs anyway.
		expect(loadedFrom).toEqual([moved.path()]);
		expect(loadedFrom).not.toContain(origin.path());

		await origin.remove();
		await moved.remove();
	});

	// `mcp.enableProjectConfig` is consumed only during discovery, and a
	// `settings`-scope refresh never enters the reconnect block — so flipping it
	// off left the project servers this session had already started connected and
	// their tools callable until an `mcp`/`all` refresh or a restart.
	it("disconnects already-running project MCP servers when enableProjectConfig is turned off", async () => {
		const dir = TempDir.createSync("@pi-refresh-mcp-projectcfg-");
		const settingsPath = `${dir.path()}/config.yml`;
		// On-disk, so the reload sees the value genuinely MOVE.
		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: true\n");
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path() });

		// One project-level server and one user-level server, so the reconcile has
		// to discriminate by source level rather than dropping everything.
		const configs = {
			"proj-server": { command: "true", args: [] },
			"user-server": { command: "true", args: [] },
		};
		const sources: Record<string, SourceMeta> = {
			"proj-server": {
				level: "project",
				path: `${dir.path()}/.mcp.json`,
				provider: "mcp",
				providerName: "MCP",
			},
			"user-server": {
				level: "user",
				path: `${dir.path()}/user.json`,
				provider: "mcp",
				providerName: "MCP",
			},
		};
		const manager = new MCPManager(dir.path(), null, async () => ({ configs, exaApiKeys: [], sources }));
		const disconnected: string[] = [];
		const realDisconnect = manager.disconnectServer.bind(manager);
		manager.disconnectServer = async (name: string) => {
			disconnected.push(name);
			return realDisconnect(name);
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
			mcpManager: manager,
			disconnectOwnedMcpManager: async () => {},
		});
		sessions.push(session);

		// Start both servers, as a session with the setting on would.
		await manager.connectServers(configs, sources);

		await fsp.writeFile(settingsPath, "mcp:\n  enableProjectConfig: false\n");
		expect((await session.refresh("settings")).settingsChanged).toBe(true);

		// Pre-fix nothing was disconnected: the setting moved, the merged value
		// updated, and the running subprocess stayed callable.
		expect(disconnected).toContain("proj-server");
		// The user-level server is not a project opt-out and must survive.
		expect(disconnected).not.toContain("user-server");

		await dir.remove();
	});
});
