import { AsyncLocalStorage } from "node:async_hooks";
import { AuthStorage } from "../auth-storage";
import { CompassAuthCredentialStore } from "./credential-store";
import type { CompassAuthCredentialStoreOptions } from "./credential-store";

export interface CompassOwnerEntry {
	storage: AuthStorage;
	store: { hasPendingWrites(): boolean };
}

export interface CompassOwnerPoolOptions {
	open: (ownerUserId: string) => Promise<CompassOwnerEntry>;
	maxOwners?: number;
	idleMs?: number;
	minIdleMs?: number;
	sweepIntervalMs?: number;
	now?: () => number;
}

interface OwnerState extends CompassOwnerEntry {
	ownerUserId: string;
	lastUsedMs: number;
	leases: number;
}

interface RequestLease {
	entries: Set<OwnerState>;
	released: boolean;
}

const DEFAULT_MAX_OWNERS = 256;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_MIN_IDLE_MS = 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export class CompassOwnerPool {
	readonly #open: CompassOwnerPoolOptions["open"];
	readonly #maxOwners: number;
	readonly #idleMs: number;
	readonly #minIdleMs: number;
	readonly #now: () => number;
	readonly #requestLease = new AsyncLocalStorage<RequestLease>();
	readonly #owners = new Map<string, OwnerState>();
	readonly #opening = new Map<string, Promise<OwnerState>>();
	readonly #sweepTimer: ReturnType<typeof setInterval> | undefined;
	#closed = false;

	constructor(opts: CompassOwnerPoolOptions) {
		this.#open = opts.open;
		this.#maxOwners = opts.maxOwners ?? DEFAULT_MAX_OWNERS;
		this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
		this.#minIdleMs = opts.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
		this.#now = opts.now ?? Date.now;
		const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
		if (sweepIntervalMs > 0) {
			this.#sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
			this.#sweepTimer.unref();
		}
	}

	/** Inside withRequestLease, also leases the entry until that request's lease ends. */
	async get(ownerUserId: string): Promise<AuthStorage> {
		if (this.#closed) throw new Error("Compass owner pool is closed");
		if (!ownerUserId) throw new Error("Compass owner id required");
		let owner = this.#owners.get(ownerUserId);
		if (!owner) {
			let opening = this.#opening.get(ownerUserId);
			if (!opening) {
				opening = this.#openOwner(ownerUserId);
				this.#opening.set(ownerUserId, opening);
			}
			try {
				owner = await opening;
			} finally {
				if (this.#opening.get(ownerUserId) === opening) this.#opening.delete(ownerUserId);
			}
		}
		if (this.#closed) throw new Error("Compass owner pool is closed");
		owner.lastUsedMs = this.#now();
		const lease = this.#requestLease.getStore();
		if (lease && !lease.released && !lease.entries.has(owner)) {
			lease.entries.add(owner);
			owner.leases += 1;
		}
		return owner.storage;
	}

	/** Runs one routed request. Leases end with the response body or when the run stops. */
	async withRequestLease<T>(run: () => Promise<T>): Promise<T> {
		const lease: RequestLease = { entries: new Set(), released: false };
		let result: T;
		try {
			result = await this.#requestLease.run(lease, run);
		} catch (error) {
			this.#release(lease);
			throw error;
		}
		if (!(result instanceof Response) || result.body === null || lease.entries.size === 0) {
			this.#release(lease);
			return result;
		}
		try {
			const response = this.#wrapResponse(result, () => this.#release(lease));
			// SAFETY: A runtime check established that the generic result is a Response.
			return response as unknown as T;
		} catch (error) {
			this.#release(lease);
			throw error;
		}
	}

	sweep(): void {
		if (this.#closed) return;
		const now = this.#now();
		for (const owner of this.#owners.values()) {
			if (this.#isEvictable(owner, now, this.#idleMs)) this.#closeOwner(owner);
		}
		if (this.#owners.size <= this.#maxOwners) return;
		const candidates = [...this.#owners.values()]
			.filter(owner => this.#isEvictable(owner, now, this.#minIdleMs))
			.sort((left, right) => left.lastUsedMs - right.lastUsedMs);
		for (const owner of candidates) {
			if (this.#owners.size <= this.#maxOwners) break;
			this.#closeOwner(owner);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
		for (const owner of this.#owners.values()) owner.storage.close();
		this.#owners.clear();
	}

	async #openOwner(ownerUserId: string): Promise<OwnerState> {
		const entry = await this.#open(ownerUserId);
		if (this.#closed) {
			entry.storage.close();
			throw new Error("Compass owner pool is closed");
		}
		const owner: OwnerState = { ...entry, ownerUserId, lastUsedMs: this.#now(), leases: 0 };
		this.#owners.set(ownerUserId, owner);
		return owner;
	}

	#isEvictable(owner: OwnerState, now: number, threshold: number): boolean {
		return owner.leases === 0 && !owner.store.hasPendingWrites() && now - owner.lastUsedMs > threshold;
	}

	#closeOwner(owner: OwnerState): void {
		if (this.#owners.get(owner.ownerUserId) !== owner) return;
		this.#owners.delete(owner.ownerUserId);
		owner.storage.close();
	}

	#release(lease: RequestLease): void {
		if (lease.released) return;
		lease.released = true;
		for (const owner of lease.entries) owner.leases = Math.max(0, owner.leases - 1);
		lease.entries.clear();
	}

	#wrapResponse(response: Response, release: () => void): Response {
		const reader = response.body?.getReader();
		if (!reader) {
			release();
			return response;
		}
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const chunk = await reader.read();
					if (chunk.done) {
						release();
						controller.close();
					} else {
						controller.enqueue(chunk.value);
					}
				} catch (error) {
					release();
					controller.error(error);
				}
			},
			cancel(reason) {
				try {
					return reader.cancel(reason).finally(release);
				} catch (error) {
					release();
					throw error;
				}
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}
}

export async function openCompassOwner(opts: CompassAuthCredentialStoreOptions): Promise<CompassOwnerEntry> {
	const store = await CompassAuthCredentialStore.open(opts);
	try {
		const storage = new AuthStorage(store, { sourceLabel: "compass" });
		await storage.credentials.reload();
		return { storage, store };
	} catch (error) {
		store.close();
		throw error;
	}
}
