/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPServerConfig, MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long an invalidation marker stays readable — the same TTL a populated
 * row gets.
 *
 * The marker carries the ordering token that tells a delayed `tools/list`
 * response its catalog has been superseded, and an MCP request has no bounded
 * lifetime: the timeout is configurable and `timeout: 0` disables it outright.
 * A marker that expires while such a request is still in flight is invisible
 * to `getCache`, so the response that finally lands sees an absent row, passes
 * the write comparison, and persists the retired catalog for the full TTL with
 * nothing to correct it. Outliving an in-flight `hashConfig()` — the window a
 * shorter TTL was sized for — is only the nearer half of the job.
 *
 * Keeping it costs one row: `get` reports an empty toolset as a MISS for as
 * long as the marker stands, so it never withholds tools, and any later
 * non-empty listing replaces it.
 */
const CACHE_TOMBSTONE_TTL_MS = CACHE_TTL_MS;
/**
 * How many times a non-empty write re-decides against a row another writer
 * committed under it. Every refusal means a peer's write landed, so a real
 * contention run terminates on its own; this only bounds a key being hammered
 * by many processes at once, where giving up simply leaves the peer's newer
 * row in place.
 */
const CACHE_WRITE_ATTEMPTS = 4;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
	/**
	 * When the `tools/list` that produced this row was ISSUED, as a Unix-epoch
	 * millisecond reading. Persisted so it travels with the row: it is the only
	 * ordering signal two writers in *different* processes share, and it is
	 * sampled before the request rather than after its response so it orders the
	 * calls by when each asked the server, not by which response came back (or
	 * finished hashing) first.
	 *
	 * Absent on rows written before this field existed; {@link readWriteStartedAt}
	 * reports that as unknown and the comparison stays conservative.
	 */
	writeStartedAt?: number;
};

/**
 * The ordering token on a persisted row, or `undefined` when the row is absent,
 * unparseable, or predates the field.
 */
function readWriteStartedAt(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const startedAt = parsed.writeStartedAt;
	return typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : undefined;
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

async function hashConfig(config: MCPServerConfig): Promise<string> {
	const stable = stableStringifyJson(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

/**
 * Sample the cross-process ordering token for a `tools/list` that is about to
 * be issued, and hand it to the {@link MCPToolCache.set} that persists the
 * response.
 *
 * `Date.now()` alone is millisecond-granular, so two catalogs observed in the
 * same millisecond would tie; `performance.now()` adds sub-millisecond
 * resolution while `timeOrigin` keeps the reading on the epoch scale every
 * process shares (a bare `performance.now()` is process-relative and would not
 * compare).
 *
 * Capture it BEFORE the request. Sampling it when the response arrives orders
 * two writers by response latency instead of by request order, so a delayed
 * response to an EARLIER `tools/list` would carry the LARGER token and
 * overwrite the newer catalog a faster later request already persisted — for
 * the full cache TTL, with nothing to correct it.
 */
export function toolCatalogObservedAt(): number {
	return performance.timeOrigin + performance.now();
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorage) {}

	/**
	 * The newest request-time ordering token any `set()` on this instance has
	 * carried for a server. `set()` for an empty toolset writes synchronously,
	 * but a non-empty `set()` must first `await hashConfig()`. So a write whose
	 * `tools/list` went out EARLIER can still be parked in `hashConfig()` when a
	 * newer one lands — and then resolve and re-persist a superseded catalog for
	 * the full TTL. Every `set()` records its token at entry and re-checks it
	 * immediately before touching storage: a write a later-issued one superseded
	 * drops instead of clobbering the newer result.
	 *
	 * The mark is a high-water reading of {@link toolCatalogObservedAt}, not an
	 * arrival counter. Entry order is response order, so a counter makes
	 * whichever response came back last authoritative: a newer refresh parked in
	 * `hashConfig()` would be knocked out by an earlier request's late response
	 * simply because that response entered afterwards, and the older catalog
	 * would then be cached for the full TTL. Comparing the same request-time
	 * token {@link set} persists keeps both halves of the ordering on one clock.
	 *
	 * This orders writers within ONE instance only, which is why it cannot be
	 * the whole story: every top-level session builds its own cache over the
	 * shared store (`sdk.ts`), and subagents and separate CLI processes add
	 * more. A same-process map cannot see a writer in another one — see the
	 * persisted `writeStartedAt` token that {@link set} compares for the
	 * cross-instance half.
	 */
	#newestObserved = new Map<string, number>();

	async get(serverName: string, config: MCPServerConfig): Promise<MCPToolDefinition[] | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		if (!Array.isArray(parsed.tools)) return null;

		let currentHash: string;
		try {
			currentHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		// An empty cached toolset is treated as a MISS. A gateway warming up (or
		// any server mid-restart) can answer `tools/list` with a successful
		// `[]`; caching that as authoritative for 30 days poisoned every later
		// session. Returning null forces a live re-list instead — and self-heals
		// any pre-fix poisoned entry on the next read.
		if (parsed.tools.length === 0) return null;

		return parsed.tools as MCPToolDefinition[];
	}

	/**
	 * Persist a `tools/list` response.
	 *
	 * `observedAt` is the caller's {@link toolCatalogObservedAt} reading, taken
	 * BEFORE it issued the `tools/list` this `tools` array answers. It becomes
	 * the row's cross-process ordering token. Sampling it here instead would
	 * order two writers by when their responses came back: a delayed response to
	 * an EARLIER request would then carry the LARGER token and overwrite the
	 * newer catalog a faster later request already persisted (or replace its
	 * empty-result tombstone) for the full TTL. Optional for callers with no
	 * request to anchor on — an out-of-band invalidation, or a test — which fall
	 * back to sampling now.
	 */
	async set(
		serverName: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		observedAt?: number,
	): Promise<void> {
		const writeStartedAt = observedAt ?? toolCatalogObservedAt();
		const newestSeen = this.#newestObserved.get(serverName);
		this.#newestObserved.set(serverName, Math.max(newestSeen ?? writeStartedAt, writeStartedAt));
		// A write is still current while nothing issued LATER has entered `set()`
		// on this instance. A tie keeps us current — two readings can land on the
		// same tick, and the storage comparison resolves that in the incumbent
		// row's favor rather than dropping both.
		const isCurrent = (): boolean => (this.#newestObserved.get(serverName) ?? writeStartedAt) <= writeStartedAt;

		// An empty `tools/list` must never leave a *stale* non-empty entry
		// standing: if the server genuinely dropped its tools, a later slow-start
		// (one whose live list misses the startup race) would load those obsolete
		// tools from cache. So invalidate — but never *create* an authoritative
		// empty one (the transient warmup empty this PR fixes): the marker is an
		// empty toolset, which `get` reports as a MISS for as long as it is
		// readable, so a live re-list still happens on every read.
		//
		// The marker is written even when nothing is cached. It is the only state
		// a concurrent writer in another instance shares with us, and that writer
		// may already be parked in `hashConfig()` holding an obsolete non-empty
		// toolset sampled when the row was absent. With no write, its post-hash
		// re-read still sees `null`, matches its own pre-hash sample, and persists
		// those obsolete tools for the full 30-day TTL. A visible row is what
		// makes that comparison fail.
		//
		// Hence a *live* row rather than an already-expired one: an expired row is
		// invisible to `getCache`'s `expires_at > now` filter, so no concurrent
		// writer could detect it. See {@link CACHE_TOMBSTONE_TTL_MS} for why the
		// row has to stay readable as long as a populated one.
		if (tools.length === 0) {
			if (!isCurrent()) return;
			const emptyPayload: MCPToolCachePayload = {
				version: CACHE_VERSION,
				configHash: "",
				tools: [],
				writeStartedAt,
			};
			// The marker takes the SAME storage-level ordering the non-empty path
			// takes. An empty write has no `hashConfig()` to park in, but it can
			// still be descheduled between claiming `writeStartedAt` and reaching
			// storage — several CLI processes share one `agent.db`, and
			// `#newestObserved` cannot see a writer in another one. An unconditional
			// write there overwrites a NEWER populated cache with a tombstone, and
			// every later startup then loses its deferred cached tools until a
			// live list succeeds — worst exactly when the server is slow or down.
			// So the same token comparison and the same conditional write decide
			// this one: defer to a row a newer `set()` already committed, replace
			// an older one, and re-decide when the row moves under us.
			this.#writeOrdered({
				serverName,
				serialized: JSON.stringify(emptyPayload),
				ttlMs: CACHE_TOMBSTONE_TTL_MS,
				writeStartedAt,
				unorderable: "replace",
			});
			return;
		}

		// Sample the persisted bytes BEFORE the await. `#newestObserved` cannot see a
		// concurrent writer in another instance — each top-level session builds
		// its own cache over the shared store, and subagents add more — so the
		// stored row is the only state both writers share, and its ordering
		// token is what tells us which of them observed the server later.
		// Re-compared below.
		const persistedBeforeHash = this.storage.getCache(cacheKey(serverName));

		let configHash: string;
		try {
			configHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
			writeStartedAt,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		// Re-check the same-instance ordering AFTER the async hash: a `set()`
		// whose `tools/list` went out later (any toolset, empty or not) has
		// entered on this instance, so its result is authoritative and persisting
		// these now would resurrect a catalog it already superseded.
		if (!isCurrent()) return;

		// Then the cross-instance ordering, which `#newestObserved` cannot see:
		// each top-level session builds its own cache over the shared store, and
		// subagents and separate CLI processes add more.
		this.#writeOrdered({
			serverName,
			serialized,
			ttlMs: CACHE_TTL_MS,
			writeStartedAt,
			baseline: { bytes: persistedBeforeHash },
			unorderable: "drop",
		});
	}

	/**
	 * Persist `serialized` only while it is still the newest observation of the
	 * server, comparing the ordering token on the row it would replace.
	 *
	 * The one storage-level ordering both write paths take. "Did the bytes
	 * change" is not enough on its own: two writes can start against the same
	 * row, and whichever reaches storage first would win regardless of which saw
	 * the server later — first-writer-wins, so an older catalog can outlive a
	 * newer one for the full TTL. The persisted token records when the *winning*
	 * `tools/list` was issued, so a call whose request went out earlier defers to
	 * a row a newer request already wrote, and a call whose request went out
	 * later replaces it even though the bytes changed under it.
	 *
	 * Deciding from a row we merely *read* settles nothing: a writer in another
	 * process shares only the store, so it can replace the row between our read
	 * and our write and we would overwrite a decision we never saw. So the row
	 * we compared is also the row the write requires — `setCacheIfMatches`
	 * refuses when the stored bytes moved, and we re-decide against whatever
	 * landed instead. Each refusal means some other writer committed, so the
	 * loop makes progress; the bound only stops a pathologically busy key from
	 * spinning, and giving up leaves that writer's row standing, which is the
	 * conservative outcome.
	 *
	 * A row carrying a token is ALWAYS compared, never skipped because it is the
	 * same row the caller sampled before its `await`. With a request-time token
	 * those two facts came apart: a write whose `tools/list` went out first can
	 * enter `set()` after a newer write has already committed, so the row it
	 * samples pre-hash is the newer one and "unchanged since I looked" no longer
	 * implies "nothing newer landed".
	 *
	 * `baseline` therefore only decides an UNORDERABLE row — one with no
	 * comparable token, so pre-token-field or unparseable. A row still identical
	 * to what the caller sampled is one it already accounted for, which is what
	 * lets a write upgrade a legacy row; any other unorderable row takes the
	 * caller's `unorderable` direction. A caller with no await passes none and
	 * every unorderable row takes that direction.
	 *
	 * `unorderable` decides a row carrying no comparable token — absent bytes
	 * aside, an unparseable row or one written before the field existed. Nothing
	 * orders us against it, so each caller takes its own conservative direction:
	 * a catalog write drops (never displace a row that might be newer), while an
	 * invalidation marker replaces it (its worst case is one forced live re-list,
	 * and retiring an unorderable stale catalog is the reason it is written).
	 */
	#writeOrdered(args: {
		serverName: string;
		serialized: string;
		ttlMs: number;
		writeStartedAt: number;
		baseline?: { bytes: string | null };
		unorderable: "drop" | "replace";
	}): void {
		const key = cacheKey(args.serverName);
		for (let attempt = 0; attempt < CACHE_WRITE_ATTEMPTS; attempt++) {
			const persistedNow = this.storage.getCache(key);
			const persistedStartedAt = readWriteStartedAt(persistedNow);
			if (persistedStartedAt !== undefined) {
				// The row's `tools/list` was issued at or after ours, so it is the
				// newer observation of the server. Leave it standing.
				if (persistedStartedAt >= args.writeStartedAt) return;
			} else if (persistedNow !== args.baseline?.bytes && args.unorderable === "drop") {
				return;
			}

			const expiresAtSec = Math.floor((Date.now() + args.ttlMs) / 1000);
			if (this.storage.setCacheIfMatches(key, persistedNow, args.serialized, expiresAtSec)) return;
		}

		logger.debug("MCP tool cache write contended out", { serverName: args.serverName });
	}
}
