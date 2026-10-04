import type { FluentType } from "@oh-my-pi/omptype";

import { logger } from "@oh-my-pi/pi-utils";
import type { AuthCredentialStore } from "../auth/store";
import type { AuthCredential, OAuthCredential, StoredAuthCredential } from "../auth/types";
import { serializeCredential } from "../auth/sqlite-credential-store";
import type { OAuthCredentials } from "../registry/oauth/types";
import type {
	DisableCredentialRequest,
	GatewayCredential,
	GatewayInt64,
	GatewayOAuthToken,
	GatewayOAuthTokenRequest,
	ListCredentialPoolRequest,
	UpdateCredentialOAuthRequest,
} from "./wire";
import {
	CompassRpcError,
	compassRpcErrorFromResponse,
	decodeCompassJson,
	disableCredentialResponseSchema,
	listCredentialPoolResponseSchema,
	updateCredentialOAuthResponseSchema,
} from "./wire";

export interface CompassAuthCredentialStoreOptions {
	baseUrl: string;
	token: string;
	agentAccountId: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Minimum gap between background pool reloads started by polling. Default 5s. */
	refreshIntervalMs?: number;
}

interface CredentialRow {
	id: number;
	serverId: string;
	provider: string;
	credential: AuthCredential;
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const EMPTY_CREDENTIALS_ERROR = "Credentials are enrolled through Compass";
const CONFLICT_CODES: ReadonlySet<string> = new Set(["aborted", "not_found"]);
// The write may or may not have landed; resending the same CAS settles it either way.
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["unavailable", "deadline_exceeded", "unknown", "internal"]);

function int64String(value: GatewayInt64): string {
	return typeof value === "string" ? value : String(value);
}

function optionalNumber(value: GatewayInt64 | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = typeof value === "string" ? Number(value) : value;
	return number ? number : undefined;
}

function oauthFromGateway(token: GatewayOAuthToken): OAuthCredential {
	const credential: OAuthCredential = {
		type: "oauth",
		access: token.access ?? "",
		refresh: token.refresh ?? "",
		expires: Number(token.expiresUnixMs ?? 0),
	};
	const authorizedAt = optionalNumber(token.authorizedAtUnixMs);
	const optionalFields: Partial<OAuthCredentials> = {
		...(token.enterpriseUrl ? { enterpriseUrl: token.enterpriseUrl } : {}),
		...(token.projectId ? { projectId: token.projectId } : {}),
		...(token.email ? { email: token.email } : {}),
		...(token.accountId ? { accountId: token.accountId } : {}),
		...(token.apiEndpoint ? { apiEndpoint: token.apiEndpoint } : {}),
		...(token.orgId ? { orgId: token.orgId } : {}),
		...(token.orgName ? { orgName: token.orgName } : {}),
		...(authorizedAt !== undefined ? { authorizedAt } : {}),
	};
	return { ...credential, ...optionalFields };
}
function oauthToGateway(credential: OAuthCredential): GatewayOAuthTokenRequest {
	const token: GatewayOAuthTokenRequest = {
		access: credential.access,
		refresh: credential.refresh,
		expiresUnixMs: String(credential.expires),
	};
	const authorizedAtUnixMs = credential.authorizedAt ? String(credential.authorizedAt) : undefined;
	return {
		...token,
		...(credential.enterpriseUrl ? { enterpriseUrl: credential.enterpriseUrl } : {}),
		...(credential.projectId ? { projectId: credential.projectId } : {}),
		...(credential.email ? { email: credential.email } : {}),
		...(credential.accountId ? { accountId: credential.accountId } : {}),
		...(credential.apiEndpoint ? { apiEndpoint: credential.apiEndpoint } : {}),
		...(credential.orgId ? { orgId: credential.orgId } : {}),
		...(credential.orgName ? { orgName: credential.orgName } : {}),
		...(authorizedAtUnixMs ? { authorizedAtUnixMs } : {}),
	};
}

function credentialFromGateway(row: GatewayCredential): AuthCredential | undefined {
	if (row.apiKey !== undefined) return { type: "api_key", key: row.apiKey, source: "login" };
	if (row.oauth !== undefined) return oauthFromGateway(row.oauth);
	return undefined;
}

/** An OAuth resend always sends the row's current credential, never a stored copy. */
type Unsynced = { kind: "oauth" } | { kind: "disable"; row: CredentialRow; cause: string };

/** Writes are queued per row so each RPC carries the version of the state its caller checked. */
interface RowState {
	version: string;
	/** Bumped on a conflict; jobs accepted under an older epoch drop instead of writing. */
	epoch: number;
	pending: number;
	/** A fire-and-forget write that failed transiently; resent before the next reload. */
	unsynced?: Unsynced;
}

/**
 * Compass-backed credential pool for one agent account. AuthPool polls on every
 * credential selection, and those polls drive background refreshes.
 */
export class CompassAuthCredentialStore implements AuthCredentialStore {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #agentAccountId: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;
	readonly #refreshIntervalMs: number;
	readonly #closeController = new AbortController();
	readonly #localIdByServerId = new Map<string, number>();
	readonly #state = new Map<string, RowState>();
	readonly #disabled = new Set<string>();
	readonly #writeChains = new Map<number, Promise<void>>();
	readonly #cache = new Map<string, CacheEntry>();
	#nextLocalId = 1;
	#rows = new Map<number, CredentialRow>();
	#fingerprint = "";
	#revision = 0;
	#acknowledgedRevision = 0;
	#refreshInFlight: Promise<void> | undefined;
	#lastRefreshStartMs = 0;
	#refreshStarted = 0;
	#refreshApplied = 0;
	#closed = false;

	constructor(opts: CompassAuthCredentialStoreOptions) {
		if (!opts.baseUrl.trim()) throw new Error("Compass baseUrl must not be empty");
		if (!opts.token.trim()) throw new Error("Compass token must not be empty");
		if (!opts.agentAccountId.trim()) throw new Error("Compass agentAccountId must not be empty");
		this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.#token = opts.token;
		this.#agentAccountId = opts.agentAccountId;
		this.#fetch = opts.fetch ?? fetch;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
	}

	static async open(opts: CompassAuthCredentialStoreOptions): Promise<CompassAuthCredentialStore> {
		const store = new CompassAuthCredentialStore(opts);
		await store.refreshSnapshot();
		store.#acknowledgedRevision = store.#revision;
		return store;
	}

	async refreshSnapshot(): Promise<StoredAuthCredential[]> {
		this.#lastRefreshStartMs = Date.now();
		const sequence = ++this.#refreshStarted;
		const request: ListCredentialPoolRequest = { agentAccountId: this.#agentAccountId };
		const response = await this.#request("ListCredentialPool", request, listCredentialPoolResponseSchema);
		// Overlapping lists can land out of order; an older one must not undo a newer one.
		if (sequence < this.#refreshApplied) return this.listAuthCredentials();
		this.#refreshApplied = sequence;
		const seen = new Set<string>();
		for (const wireRow of response.credentials ?? []) {
			if (this.#disabled.has(wireRow.id)) continue;
			seen.add(wireRow.id);
			const id = this.#localIdFor(wireRow.id);
			const state = this.#state.get(wireRow.id);
			const version = int64String(wireRow.version);
			// A pending write or a newer local version outranks a list that may predate it.
			if (state && (this.#isHeld(state) || BigInt(version) < BigInt(state.version))) continue;
			const credential = credentialFromGateway(wireRow);
			if (credential === undefined) {
				logger.warn("Compass credential row has no credential payload", {
					id: wireRow.id,
					provider: wireRow.provider,
				});
				this.#rows.delete(id);
				continue;
			}
			if (state) state.version = version;
			else this.#state.set(wireRow.id, { version, epoch: 0, pending: 0 });
			this.#rows.set(id, { id, serverId: wireRow.id, provider: wireRow.provider, credential });
		}
		for (const [id, row] of this.#rows) {
			const state = this.#state.get(row.serverId);
			if (seen.has(row.serverId) || (state && this.#isHeld(state))) continue;
			this.#rows.delete(id);
		}
		this.#refreshRevision();
		return this.listAuthCredentials();
	}

	pollExternalChanges(): boolean {
		this.#maybeBackgroundRefresh();
		if (this.#revision === this.#acknowledgedRevision) return false;
		this.#acknowledgedRevision = this.#revision;
		return true;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const credentials: StoredAuthCredential[] = [];
		for (const id of [...this.#rows.keys()].sort((a, b) => a - b)) {
			const row = this.#rows.get(id);
			if (!row || (provider !== undefined && row.provider !== provider)) continue;
			credentials.push({ id: row.id, provider: row.provider, credential: row.credential, disabledCause: null });
		}
		return credentials;
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		if (this.#closed || credential.type !== "oauth") return;
		const row = this.#rows.get(id);
		if (!row || row.credential.type !== "oauth") return;
		this.#acceptOAuthUpdate(row, credential);
	}

	tryUpdateAuthCredentialIfMatches(id: number, expectedData: string, credential: AuthCredential): boolean {
		if (this.#closed || credential.type !== "oauth") return false;
		const row = this.#rows.get(id);
		if (!row || row.credential.type !== "oauth") return false;
		if (serializeCredential(row.provider, row.credential)?.data !== expectedData) return false;
		this.#acceptOAuthUpdate(row, credential);
		return true;
	}

	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, cause: string): boolean {
		if (this.#closed) return false;
		const row = this.#rows.get(id);
		if (!row) return false;
		if (serializeCredential(row.provider, row.credential)?.data !== expectedData) return false;
		this.#removeLocalRow(id);
		this.#queueDisable(row, cause);
		return true;
	}

	/** Unconditional: after a lost race it retries once against the reloaded version. */
	async deleteAuthCredential(id: number, cause: string): Promise<boolean> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (this.#closed) return false;
			const row = this.#rows.get(id);
			if (!row) return false;
			const epoch = this.#accept(row.serverId);
			if ((await this.#runWrite(row, epoch, undefined, () => this.#disable(row, cause))) === true) return true;
			if (this.#disabled.has(row.serverId)) return false;
		}
		return false;
	}

	upsertAuthCredential(_provider: string, _credential: AuthCredential): Promise<StoredAuthCredential[]> {
		return Promise.reject(new Error(EMPTY_CREDENTIALS_ERROR));
	}

	replaceAuthCredentials(_provider: string, _credentials: AuthCredential[]): Promise<StoredAuthCredential[]> {
		return Promise.reject(new Error(EMPTY_CREDENTIALS_ERROR));
	}

	deleteAuthCredentials(_provider: string, _cause: string): Promise<void> {
		return Promise.reject(new Error(EMPTY_CREDENTIALS_ERROR));
	}

	getCache(key: string, options: { includeExpired?: boolean } = {}): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (!options.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#cache.set(key, { value, expiresAtSec });
	}

	deleteCachePrefix(prefix: string): void {
		for (const key of this.#cache.keys()) {
			if (key.startsWith(prefix)) this.#cache.delete(key);
		}
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
	}

	/** Resolves once every queued write and background refresh has settled. */
	async flush(): Promise<void> {
		while (this.#writeChains.size > 0 || this.#refreshInFlight) {
			await Promise.all([...this.#writeChains.values(), this.#refreshInFlight]);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeController.abort();
	}

	#localIdFor(serverId: string): number {
		let id = this.#localIdByServerId.get(serverId);
		if (id === undefined) {
			id = this.#nextLocalId++;
			this.#localIdByServerId.set(serverId, id);
		}
		return id;
	}

	#stateFor(serverId: string): RowState {
		const state = this.#state.get(serverId);
		if (!state) throw new Error("Compass credential row has no version state");
		return state;
	}

	#isHeld(state: RowState): boolean {
		return state.pending > 0 || state.unsynced !== undefined;
	}

	#accept(serverId: string): number {
		const state = this.#stateFor(serverId);
		state.pending += 1;
		return state.epoch;
	}

	#acceptOAuthUpdate(row: CredentialRow, credential: OAuthCredential): void {
		row.credential = credential;
		this.#refreshRevision();
		this.#queueOAuthUpdate(row, credential);
	}

	#queueOAuthUpdate(row: CredentialRow, credential: OAuthCredential): void {
		const epoch = this.#accept(row.serverId);
		void this.#runWrite(row, epoch, { kind: "oauth" }, async () => {
			const state = this.#stateFor(row.serverId);
			const request: UpdateCredentialOAuthRequest = {
				id: row.serverId,
				token: oauthToGateway(credential),
				expectedVersion: state.version,
			};
			const response = await this.#request("UpdateCredentialOAuth", request, updateCredentialOAuthResponseSchema);
			state.version = int64String(response.version);
			// The chain is FIFO, so this write supersedes any earlier failed one.
			if (state.unsynced?.kind === "oauth") state.unsynced = undefined;
		}).catch(error => this.#logWriteFailure("Compass OAuth update failed", row, this.#errorCode(error)));
	}

	#queueDisable(row: CredentialRow, cause: string): void {
		const epoch = this.#accept(row.serverId);
		void this.#runWrite(row, epoch, { kind: "disable", row, cause }, () => this.#disable(row, cause)).catch(error =>
			this.#logWriteFailure("Compass credential disable failed", row, this.#errorCode(error)),
		);
	}

	#resendUnsynced(): void {
		for (const [serverId, state] of this.#state) {
			const unsynced = state.unsynced;
			if (!unsynced || state.pending > 0) continue;
			const id = this.#localIdByServerId.get(serverId);
			if (id === undefined) continue;
			if (unsynced.kind === "oauth") {
				const row = this.#rows.get(id);
				if (row?.credential.type === "oauth") this.#queueOAuthUpdate(row, row.credential);
				else state.unsynced = undefined;
			} else {
				this.#queueDisable(unsynced.row, unsynced.cause);
			}
		}
	}

	async #disable(row: CredentialRow, cause: string): Promise<boolean> {
		const state = this.#stateFor(row.serverId);
		const request: DisableCredentialRequest = { id: row.serverId, cause, expectedVersion: state.version };
		try {
			await this.#request("DisableCredential", request, disableCredentialResponseSchema);
		} catch (error) {
			if (this.#errorCode(error) !== "not_found") throw error;
			this.#tombstone(row);
			return false;
		}
		this.#tombstone(row);
		return true;
	}

	#tombstone(row: CredentialRow): void {
		this.#disabled.add(row.serverId);
		this.#stateFor(row.serverId).unsynced = undefined;
		this.#removeLocalRow(row.id);
	}

	/**
	 * Runs one write on the row's chain. A conflict bumps the epoch so every job accepted
	 * before it drops, then reloads the pool. A transient failure keeps `unsynced` for a resend.
	 */
	#runWrite<T>(
		row: CredentialRow,
		epoch: number,
		unsynced: Unsynced | undefined,
		work: () => Promise<T>,
	): Promise<T | false> {
		const job = async (): Promise<T | false> => {
			const state = this.#state.get(row.serverId);
			if (this.#closed || !state || state.epoch !== epoch) return false;
			try {
				return await work();
			} catch (error) {
				const code = this.#errorCode(error);
				if (!CONFLICT_CODES.has(code)) {
					// A definitive failure releases the row so the next list reconciles it from the server.
					if (unsynced && !this.#closed) state.unsynced = TRANSIENT_CODES.has(code) ? unsynced : undefined;
					throw error;
				}
				state.epoch += 1;
				state.pending = 0;
				state.unsynced = undefined;
				this.#logWriteFailure("Compass credential write conflicted; reloading pool", row, code);
				await this.#refreshQuietly();
				return false;
			} finally {
				if (state.epoch === epoch) state.pending = Math.max(0, state.pending - 1);
			}
		};
		const previous = this.#writeChains.get(row.id) ?? Promise.resolve();
		const result = previous.then(job, job);
		const chain = result.then(
			() => undefined,
			() => undefined,
		);
		this.#writeChains.set(row.id, chain);
		void chain.then(() => {
			if (this.#writeChains.get(row.id) === chain) this.#writeChains.delete(row.id);
		});
		return result;
	}

	#maybeBackgroundRefresh(): void {
		if (this.#closed || this.#refreshInFlight) return;
		if (Date.now() - this.#lastRefreshStartMs < this.#refreshIntervalMs) return;
		this.#resendUnsynced();
		this.#refreshInFlight = this.#refreshQuietly().finally(() => {
			this.#refreshInFlight = undefined;
		});
	}

	async #refreshQuietly(): Promise<void> {
		try {
			await this.refreshSnapshot();
		} catch (error) {
			if (this.#closed) return;
			logger.warn("Compass credential pool reload failed", { code: this.#errorCode(error) });
		}
	}

	#removeLocalRow(id: number): void {
		if (!this.#rows.delete(id)) return;
		this.#refreshRevision();
	}

	#refreshRevision(): void {
		const parts: string[] = [];
		for (const row of this.#rows.values()) {
			parts.push(row.id + "\0" + row.provider + "\0" + JSON.stringify(row.credential));
		}
		parts.sort();
		const fingerprint = parts.join("\u0001");
		if (fingerprint === this.#fingerprint) return;
		this.#fingerprint = fingerprint;
		this.#revision += 1;
	}

	#errorCode(error: unknown): string {
		return error instanceof CompassRpcError ? error.code : "unknown";
	}

	#logWriteFailure(message: string, row: CredentialRow, code: string): void {
		logger.warn(message, { id: row.id, provider: row.provider, code });
	}

	async #request<T>(
		method: "ListCredentialPool" | "UpdateCredentialOAuth" | "DisableCredential",
		body: ListCredentialPoolRequest | UpdateCredentialOAuthRequest | DisableCredentialRequest,
		schema: FluentType<T>,
	): Promise<T> {
		if (this.#closed) throw new CompassRpcError("closed", "Compass credential store is closed");
		const signal = AbortSignal.any([this.#closeController.signal, AbortSignal.timeout(this.#timeoutMs)]);
		let response: Response;
		let text: string;
		try {
			response = await this.#fetch(this.#baseUrl + "/compass.v1.GatewayCredentials/" + method, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					Authorization: "Bearer " + this.#token,
				},
				body: JSON.stringify(body),
				signal,
			});
			text = await response.text();
		} catch (cause) {
			throw this.#transportError(cause);
		}
		if (!response.ok) throw compassRpcErrorFromResponse(response.status, text);
		return decodeCompassJson(text, schema);
	}

	#transportError(cause: unknown): CompassRpcError {
		if (this.#closed) return new CompassRpcError("closed", "Compass credential store is closed", { cause });
		if (cause instanceof DOMException && cause.name === "TimeoutError") {
			return new CompassRpcError("deadline_exceeded", "Compass RPC timed out", { cause });
		}
		if (cause instanceof DOMException && cause.name === "AbortError") {
			return new CompassRpcError("canceled", "Compass RPC was canceled", { cause });
		}
		return new CompassRpcError("unavailable", "Compass RPC transport failed", { cause });
	}
}
