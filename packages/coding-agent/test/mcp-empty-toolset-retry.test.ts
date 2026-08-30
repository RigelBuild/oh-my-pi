/**
 * Regression test for the whole-session MCP outage: a successful-but-empty
 * `tools/list` during an aggregating gateway's cold-start warmup left the
 * session with zero MCP tools for its entire lifetime.
 *
 * Verbatim repro (see fixtures/warmup-empty-tools-mcp.ts): a healthy stdio MCP
 * server answers its first `tools/list` with `{"tools":[]}` (a 200, not an
 * error), then advertises its real tools on the next call. The connection
 * never drops, so recovery cannot come from the reconnect path — it must come
 * from an in-session re-list.
 *
 * Contracts defended:
 *   1. Auto-heal on connect: a connected server that first lists empty is
 *      re-listed on a bounded backoff; once its tools appear they are
 *      registered and `#onToolsChanged` fires — no reconnect, no user action.
 *   2. The empty pass is never cached (no 30-day poison) — asserted via the
 *      tool cache staying empty for that server after the empty list.
 *   3. `/mcp refresh` primitive: `refreshAllTools()` re-lists every live
 *      connection and picks up tools that appeared after the initial connect.
 *
 * Timing note: this is a real subprocess integration test. The auto-retry
 * backoff runs on the platform clock inside a spawned MCP server's transport,
 * so fake timers cannot drive it. Rather than sleep-poll, tests await the
 * manager's own `#onToolsChanged` signal directly; the `it(…, timeout)` bound
 * fails the test if the heal never fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "warmup-empty-tools-mcp.ts");
const BUN_EXEC = process.execPath;

function createFakeStorage(): AgentStorage & { raw: Map<string, string> } {
	const raw = new Map<string, string>();
	const stub = {
		raw,
		getCache(key: string): string | null {
			return raw.get(key) ?? null;
		},
		setCache(key: string, value: string): void {
			raw.set(key, value);
		},
	};
	return stub as unknown as AgentStorage & { raw: Map<string, string> };
}

describe("MCP empty-toolset warmup recovery", () => {
	let workDir: string;
	let listLog: string;
	const originalRetryMs = Bun.env.OMP_MCP_EMPTY_RETRY_MS;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-warmup-"));
		listLog = path.join(workDir, "lists.log");
		fs.writeFileSync(listLog, "");
		// Keep the auto-retry backoff tiny so the heal fires promptly instead of
		// waiting out the production schedule.
		Bun.env.OMP_MCP_EMPTY_RETRY_MS = "20";
	});

	afterEach(() => {
		if (originalRetryMs === undefined) delete Bun.env.OMP_MCP_EMPTY_RETRY_MS;
		else Bun.env.OMP_MCP_EMPTY_RETRY_MS = originalRetryMs;
		removeSyncWithRetries(workDir);
	});

	function stdioConfig(): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_TOOLS_PER_LIST: "0,1", OMP_TEST_LIST_LOG: listLog },
		};
	}

	function warmupTools(manager: MCPManager): { name: string }[] {
		return manager.getTools().filter(t => t.name.startsWith("mcp__warmup_"));
	}

	it("auto-heals a session that connected during the empty-list window", async () => {
		const storage = createFakeStorage();
		const manager = new MCPManager(workDir, new MCPToolCache(storage));

		// Await the real signal the heal emits rather than sleep-polling: resolve
		// once #onToolsChanged reports the warmed tool registered.
		const healed = Promise.withResolvers<void>();
		const toolsChangedCounts: number[] = [];
		manager.setOnToolsChanged(tools => {
			const warmed = tools.filter(t => t.name.startsWith("mcp__warmup_")).length;
			toolsChangedCounts.push(warmed);
			if (warmed === 1) healed.resolve();
		});

		try {
			// Initial connect lands in the empty window: 0 tools, but connected.
			const result = await manager.connectServers({ warmup: stdioConfig() }, {});
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);

			// The empty pass must NOT be cached (that is the 30-day poison).
			expect(storage.raw.size).toBe(0);

			// Auto-retry re-lists and registers the warmed tool with no reconnect
			// and no user action.
			await healed.promise;

			expect(warmupTools(manager)).toHaveLength(1);
			// The heal fired #onToolsChanged with the populated set.
			expect(toolsChangedCounts.some(count => count === 1)).toBe(true);
			// The server never dropped — recovery came from a re-list, not a
			// reconnect.
			expect(manager.getConnectionStatus("warmup")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("re-lists live connections on refreshAllTools (/mcp refresh primitive)", async () => {
		// Disable auto-retry so the ONLY thing that can pick up the warmed tool
		// is the explicit refresh — isolates the manual-recovery contract.
		Bun.env.OMP_MCP_EMPTY_RETRY_MS = "0";
		const manager = new MCPManager(workDir);

		try {
			const result = await manager.connectServers({ warmup: stdioConfig() }, {});
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);
			// With auto-retry off, the empty toolset stands until we refresh.
			expect(warmupTools(manager)).toEqual([]);

			await manager.refreshAllTools();

			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("stops re-listing once a sanitized-name server recovers (owner-count, not name-prefix)", async () => {
		// Server name `warmup-1` sanitizes to `warmup` for tool names (the `-1`
		// collapses to `_`, then the trailing `_` is stripped), so its tools
		// register as `mcp__warmup_*`. A `mcp__${name}_` = `mcp__warmup-1_`
		// ownership prefix therefore never matches its own tools, so the retry
		// loop's success guard would stay 0 forever and burn the whole backoff
		// (~5 redundant re-lists) before mislogging "retry exhausted" — despite
		// recovery. Owner-matching via `mcpServerName` is what makes the loop
		// terminate. The digit-free tool names keep the tool segment stable, so
		// the ONLY moving part under test is the server-segment ownership match.
		const manager = new MCPManager(workDir);

		const healed = Promise.withResolvers<void>();
		manager.setOnToolsChanged(tools => {
			if (tools.filter(t => t.mcpServerName === "warmup-1").length === 1) healed.resolve();
		});

		try {
			const result = await manager.connectServers({ "warmup-1": stdioConfig() }, {});
			expect(result.tools.filter(t => t.mcpServerName === "warmup-1")).toEqual([]);

			// Recovery still registers the tool — the bug is in the loop's
			// termination signal, not tool ownership on the register path.
			await healed.promise;
			expect(manager.getTools().filter(t => t.mcpServerName === "warmup-1")).toHaveLength(1);

			// Settle well past the full override schedule ([20,40,80,160,320]ms,
			// cumulative 620ms) so a non-terminating loop would have exhausted it.
			await Bun.sleep(900);

			// The loop terminated after the first re-list that produced a tool:
			// one empty list on connect + one recovery list = 2. The prefix bug
			// never early-returns, so it re-lists on every delay (1 + 5 = 6).
			const lists = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			expect(lists).toHaveLength(2);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("coalesces concurrent refreshes for the same connection onto one tools/list", async () => {
		// A manual `/mcp refresh` overlapping the automatic empty-toolset re-list
		// must not each fire their own `tools/list`. Two concurrent
		// `refreshServerTools` for the same live connection share one in-flight
		// request; without the guard each clears `connection.tools` and re-lists
		// independently, and an older response can overwrite a newer one.
		Bun.env.OMP_MCP_EMPTY_RETRY_MS = "0";
		const manager = new MCPManager(workDir);

		try {
			await manager.connectServers({ warmup: stdioConfig() }, {});
			// Connect listed once (empty). Baseline.
			const listsAfterConnect = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			expect(listsAfterConnect).toHaveLength(1);

			// Fire two refreshes in the same tick. The second must observe the
			// first's in-flight promise and reuse it.
			await Promise.all([manager.refreshServerTools("warmup"), manager.refreshServerTools("warmup")]);

			const listsAfterRefresh = fs
				.readFileSync(listLog, "utf8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			// Coalesced: exactly one additional tools/list. Pre-fix: two.
			expect(listsAfterRefresh).toHaveLength(2);
			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("discards a stale empty re-list once the connection was replaced (no toolless overwrite)", async () => {
		// Reproduces the stale-overwrite race: an empty `tools/list` that was in
		// flight against the ORIGINAL connection lands after a reconnect+refresh
		// already recovered populated tools under the same name. Applying the
		// stale `[]` unconditionally would wipe the recovered tools permanently.
		// The connection-identity guard drops the response instead.
		Bun.env.OMP_MCP_EMPTY_RETRY_MS = "0";
		const manager = new MCPManager(workDir);

		try {
			await manager.connectServers({ warmup: stdioConfig() }, {});
			const original = manager.getConnection("warmup");
			if (!original) throw new Error("expected an initial connection");

			// Gate an empty `tools/list` on the ORIGINAL connection: it enters the
			// request, then parks until we release it — standing in for the
			// auto-retry loop's re-list that raced the manual recovery.
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const realRequest = original.transport.request.bind(original.transport);
			original.transport.request = (<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
				if (method === "tools/list") {
					entered.resolve();
					return gate.promise.then(() => ({ tools: [] }) as T);
				}
				return realRequest<T>(method, params);
			}) as typeof original.transport.request;

			const staleReList = manager.refreshServerTools("warmup");
			// Await the real signal that the stale re-list reached its parked
			// request, rather than guessing a delay, before replacing the
			// connection out from under it.
			await entered.promise;

			// Replace the connection under the same name (disconnect + reconnect),
			// then recover real tools on the replacement.
			await manager.disconnectServer("warmup");
			await manager.connectServers({ warmup: stdioConfig() }, {});
			await manager.refreshServerTools("warmup");
			expect(warmupTools(manager)).toHaveLength(1);
			const replacement = manager.getConnection("warmup");
			expect(replacement).not.toBe(original);

			// Release the stale empty response. It must NOT overwrite the recovered
			// tools — the guard sees the connection is no longer current.
			gate.resolve();
			await staleReList;

			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
