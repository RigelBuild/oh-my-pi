import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import type { Api, Model } from "../types";
import type { ModelResolver } from "./dispatch";
import type { AgentCaller } from "./types";

/** One stable name's ordered upstream candidates and the listing metadata taken from its primary. */
export interface StableNameEntry {
	displayName?: string;
	candidates: ReadonlyArray<{ provider: string; modelId: string }>;
	/** Overrides for the primary's listing row; absent or 0 keeps the catalog value. */
	contextWindow?: number;
	/** USD per million tokens, as in `Model.cost`. */
	inputCost?: number;
	outputCost?: number;
}

export interface StableNameRegistry {
	/** The registry, loading it if none is held yet; a throw means no registry is available. */
	current(): Promise<ReadonlyMap<string, StableNameEntry>>;
	/** The registry already held, without waiting on the network. */
	held(): ReadonlyMap<string, StableNameEntry> | undefined;
}

export interface StableNameResolverOptions {
	registry: StableNameRegistry;
	resolveStorage: (caller: AgentCaller) => AuthStorage | Promise<AuthStorage>;
	lookupModel: (provider: string, modelId: string) => Model<Api> | undefined;
	/** Resolves every id the registry does not name. */
	fallback: ModelResolver;
}

export interface StableNameResolver {
	resolveModel: ModelResolver;
	listAliases: () => Iterable<{ id: string; model: Model<Api> }>;
}

/**
 * Resolves a stable name to its first candidate the caller's pool can serve, judged by
 * `keys.hasUsable`, so the choice holds steady until a credential mark changes.
 */
export function createStableNameResolver(options: StableNameResolverOptions): StableNameResolver {
	const resolveModel: ModelResolver = async (modelId, caller) => {
		let entries: ReadonlyMap<string, StableNameEntry>;
		try {
			entries = await options.registry.current();
		} catch {
			// Provider-qualified ids never needed the registry, so its outage must not fail them; the registry logs it.
			return options.fallback(modelId, caller);
		}
		const entry = entries.get(modelId);
		if (!entry) return options.fallback(modelId, caller);
		if (caller.kind !== "agent") return undefined;

		const storage = await options.resolveStorage(caller);
		let firstKnown: Model<Api> | undefined;
		for (const candidate of entry.candidates) {
			const model = options.lookupModel(candidate.provider, candidate.modelId);
			if (!model) continue;
			firstKnown ??= model;
			if (storage.keys.hasUsable(candidate.provider, { modelId: candidate.modelId })) return model;
		}
		// No usable candidate: the first known one lets the routing core report the real credential error.
		if (!firstKnown) logger.warn("stable name has no candidate in the model catalog", { modelId });
		return firstKnown;
	};

	const listAliases = function* (): Iterable<{ id: string; model: Model<Api> }> {
		// Listing is synchronous, so it serves the held registry and lets the next listing see a load.
		options.registry.current().catch(() => {});
		for (const [stableName, entry] of options.registry.held() ?? []) {
			const primary = entry.candidates[0];
			if (!primary) continue;
			const model = options.lookupModel(primary.provider, primary.modelId);
			if (!model) continue;
			yield {
				id: stableName,
				model: {
					...model,
					name: entry.displayName || model.name,
					contextWindow: entry.contextWindow || model.contextWindow,
					cost: {
						...model.cost,
						...(entry.inputCost ? { input: entry.inputCost } : {}),
						...(entry.outputCost ? { output: entry.outputCost } : {}),
					},
				},
			};
		}
	};
	return { resolveModel, listAliases };
}
