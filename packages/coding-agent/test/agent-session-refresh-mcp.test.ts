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
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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

	async function makeSession(): Promise<AgentSession> {
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
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map<string, AgentTool>(),
			extensionRoots: () => roots,
		});
		sessions.push(session);
		return session;
	}

	it("threads the session's extension roots into MCP rediscovery", async () => {
		const manager = fakeManager();
		MCPManager.setInstance(manager as unknown as MCPManager);
		const session = await makeSession();

		const result = await session.refresh("mcp");

		expect(result.mcp).toBe(true);
		expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		// Pre-fix: refresh called discoverAndConnect WITHOUT extensionRoots, so
		// extension-declared servers were dropped on reconnect.
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({ extensionRoots: roots });
	});

	it("runs sequential and overlapping refreshes to completion (no dead restart latch)", async () => {
		const manager = fakeManager();
		MCPManager.setInstance(manager as unknown as MCPManager);
		const session = await makeSession();

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
});
