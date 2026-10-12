import type { FluentType } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { StableNameEntry, StableNameRegistry } from "../auth-gateway/stable-names";
import {
	CompassRpcError,
	compassRpcErrorFromResponse,
	decodeCompassJson,
	type GatewayInt64,
	type GetGatewayModelRegistryResponse,
	getGatewayModelRegistryResponseSchema,
	getGatewayModelRegistryVersionResponseSchema,
	normalizeCompassBaseUrl,
} from "./wire";

export interface CompassModelRegistryOptions {
	baseUrl: string;
	token: string;
	fetch?: FetchImpl;
	/** Per-RPC deadline. Default 10s. */
	timeoutMs?: number;
	/** How long a checked version is trusted before a read starts a background re-check. Default 5s. */
	refreshIntervalMs?: number;
	now?: () => number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;

interface Snapshot {
	version: bigint;
	entries: ReadonlyMap<string, StableNameEntry>;
}

/** The Compass Server's stable-name registry, held in memory and re-read when its version changes. */
export class CompassModelRegistry implements StableNameRegistry {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	#snapshot: Snapshot | undefined;
	#lastCheckMs = Number.NEGATIVE_INFINITY;
	#checkInFlight: Promise<Snapshot> | undefined;
	#coldFailure: unknown;

	constructor(options: CompassModelRegistryOptions) {
		this.#baseUrl = normalizeCompassBaseUrl(options.baseUrl);
		if (!options.token.trim()) throw new Error("Compass token must not be empty");
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#now = options.now ?? Date.now;
	}

	/** The registry version held, or undefined before the first load. */
	get version(): bigint | undefined {
		return this.#snapshot?.version;
	}

	async current(): Promise<ReadonlyMap<string, StableNameEntry>> {
		const held = this.held();
		if (held) return held;
		// A cold registry that just failed answers at once, so a down Compass never stalls every request.
		if (this.#coldFailure !== undefined && this.#now() - this.#lastCheckMs < this.#refreshIntervalMs) {
			throw this.#coldFailure;
		}
		return (await this.#startCheck()).entries;
	}

	held(): ReadonlyMap<string, StableNameEntry> | undefined {
		if (!this.#snapshot) return undefined;
		// A warm registry never makes a request wait on Compass; the re-check runs behind it.
		if (this.#now() - this.#lastCheckMs >= this.#refreshIntervalMs) this.#startCheck().catch(() => {});
		return this.#snapshot.entries;
	}

	/** Waits for any background re-check to finish; its failure is already logged. */
	async settled(): Promise<void> {
		await this.#checkInFlight?.catch(() => {});
	}

	#startCheck(): Promise<Snapshot> {
		this.#checkInFlight ??= this.#check().finally(() => {
			this.#checkInFlight = undefined;
		});
		return this.#checkInFlight;
	}

	async #check(): Promise<Snapshot> {
		try {
			const { version } = await this.#request(
				"GetGatewayModelRegistryVersion",
				getGatewayModelRegistryVersionResponseSchema,
			);
			if (!this.#snapshot || this.#snapshot.version !== BigInt(version ?? 0)) {
				const response = await this.#request("GetGatewayModelRegistry", getGatewayModelRegistryResponseSchema);
				// The payload's own version, so a write between the two reads is re-fetched next check.
				this.#snapshot = parseSnapshot(response);
			}
			this.#lastCheckMs = this.#now();
			this.#coldFailure = undefined;
			return this.#snapshot;
		} catch (error) {
			// Readers keep the held registry; the stamp stops a down Compass being retried on every read.
			this.#lastCheckMs = this.#now();
			if (!this.#snapshot) this.#coldFailure = error;
			logger.warn("Compass model registry read failed", {
				code: error instanceof CompassRpcError ? error.code : "unknown",
				held: this.#snapshot !== undefined,
			});
			throw error;
		}
	}

	async #request<T>(
		method: "GetGatewayModelRegistryVersion" | "GetGatewayModelRegistry",
		schema: FluentType<T>,
	): Promise<T> {
		let response: Response;
		let text: string;
		try {
			response = await this.#fetch(`${this.#baseUrl}/compass.v1.GatewayRegistry/${method}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					Authorization: "Bearer " + this.#token,
				},
				body: "{}",
				// A redirect would replay the bearer to another origin.
				redirect: "error",
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			text = await response.text();
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === "TimeoutError") {
				throw new CompassRpcError("deadline_exceeded", "Compass RPC timed out", { cause });
			}
			throw new CompassRpcError("unavailable", "Compass RPC transport failed", { cause });
		}
		if (!response.ok) throw compassRpcErrorFromResponse(response.status, text);
		return decodeCompassJson(text, schema);
	}
}

function positive(value: GatewayInt64 | undefined): number | undefined {
	const number = Number(value ?? 0);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseSnapshot(response: GetGatewayModelRegistryResponse): Snapshot {
	const entries = new Map<string, StableNameEntry>();
	for (const [name, entry] of Object.entries(response.registry?.entries ?? {})) {
		const candidates = entry.candidates ?? [];
		if (candidates.length === 0) continue;
		const inputMicroUsd = positive(entry.metadata?.inputCostMicroUsd);
		const outputMicroUsd = positive(entry.metadata?.outputCostMicroUsd);
		entries.set(name, {
			displayName: entry.displayName,
			candidates,
			contextWindow: positive(entry.metadata?.contextWindow),
			// The wire carries integer micro-USD per million tokens; Model.cost is USD per million.
			inputCost: inputMicroUsd === undefined ? undefined : inputMicroUsd / 1_000_000,
			outputCost: outputMicroUsd === undefined ? undefined : outputMicroUsd / 1_000_000,
		});
	}
	return { version: BigInt(response.version ?? 0), entries };
}
