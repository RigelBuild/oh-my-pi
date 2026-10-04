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
// A timed-out write may have committed, so it is treated like a lost race.
const CONFLICT_CODES: ReadonlySet<string> = new Set(["aborted", "not_found", "deadline_exceeded"]);

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

/** Writes are queued per row so each RPC carries the version of the state its caller checked. */
interface RowState {
	version: string;
	/** Bumped on a conflict; jobs accepted under an older epoch drop instead of writing. */
	epoch: number;
	pending: number;
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
		const request: ListCredentialPoolRequest = { agentAccountId: this.#agentAccountId };
		const response = await this.#request("ListCredentialPool", request, listCredentialPoolResponseSchema);
		const seen = new Set<string>();
		for (const wireRow of response.credentials ?? []) {
			if (this.#disabled.has(wireRow.id)) continue;
			seen.add(wireRow.id);
			const id = this.#localIdFor(wireRow.id);
			const state = this.#state.get(wireRow.id);
			const version = int64String(wireRow.version);
			// A pending write or a newer local version outranks a list that may predate it.
			if (state && (state.pending > 0 || BigInt(version) < BigInt(state.version))) continue;
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
			if (seen.has(row.serverId) || (this.#state.get(row.serverId)?.pending ?? 0) > 0) continue;
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
		const epoch = this.#accept(row.serverId);
		this.#removeLocalRow(id);
		void this.#runWrite(row, epoch, () => this.#disable(row, cause)).catch(error => {
			this.#logWriteFailure("Compass credential disable failed", row, this.#errorCode(error));
		});
		return true;
	}

	async deleteAuthCredential(id: number, cause: string): Promise<boolean> {
		if (this.#closed) return false;
		const row = this.#rows.get(id);
		if (!row) return false;
		const epoch = this.#accept(row.serverId);
		const result = await this.#runWrite(row, epoch, () => this.#disable(row, cause));
		return result === true;
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

	#accept(serverId: string): number {
		let state = this.#state.get(serverId);
		if (!state) {
			state = { version: "0", epoch: 0, pending: 0 };
			this.#state.set(serverId, state);
		}
		state.pending += 1;
		return state.epoch;
	}

	#acceptOAuthUpdate(row: CredentialRow, credential: OAuthCredential): void {
		const epoch = this.#accept(row.serverId);
		row.credential = credential;
		this.#refreshRevision();
		void this.#runWrite(row, epoch, async () => {
			const state = this.#state.get(row.serverId);
			if (!state) return;
			const request: UpdateCredentialOAuthRequest = {
				id: row.serverId,
				token: oauthToGateway(credential),
				expectedVersion: state.version,
			};
			const response = await this.#request("UpdateCredentialOAuth", request, updateCredentialOAuthResponseSchema);
			state.version = int64String(response.version);
		}).catch(error => {
			this.#logWriteFailure("Compass OAuth update failed", row, this.#errorCode(error));
		});
	}

	async #disable(row: CredentialRow, cause: string): Promise<boolean> {
		const state = this.#state.get(row.serverId);
		if (!state) return false;
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
		this.#removeLocalRow(row.id);
	}

	/**
	 * Runs one write on the row's chain. A conflict bumps the epoch so every job accepted
	 * before it drops, then reloads the pool; other errors reject to the caller.
	 */
	#runWrite<T>(row: CredentialRow, epoch: number, work: () => Promise<T>): Promise<T | false> {
		const job = async (): Promise<T | false> => {
			const state = this.#state.get(row.serverId);
			if (this.#closed || !state || state.epoch !== epoch) return false;
			try {
				return await work();
			} catch (error) {
				const code = this.#errorCode(error);
				if (!CONFLICT_CODES.has(code)) throw error;
				state.epoch += 1;
				state.pending = 0;
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
