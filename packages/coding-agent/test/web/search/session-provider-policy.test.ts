/**
 * Provider order/exclusions are per-project settings, but the implementation
 * kept them in module-level state that the LAST caller of
 * `applyProviderGlobalsFromSettings` (startup, the interactive selector, or any
 * session's `/refresh settings`) owned outright. With two top-level SDK/ACP
 * sessions in one process, refreshing session A therefore redirected session
 * B's searches to A's order and exclusions.
 *
 * The fix threads each session's own resolved policy through the existing
 * request seams, leaving the module state as the fallback for callers that
 * genuinely have no session (the one-shot CLI, embedding harnesses).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import {
	createSearchProviderPolicy,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchPublicWeb } from "@oh-my-pi/pi-coding-agent/web/search/providers/public";
import type { SearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";

const authStorage = { hasAuth: () => true } as unknown as AuthStorage;

/**
 * A session carrying its OWN settings instance, exactly as a top-level SDK/ACP
 * session does. `Settings.isolated` never touches the global singleton, so two
 * of these are genuinely independent.
 */
function makeSession(order: SearchProviderId[], excluded: SearchProviderId[] = []): ToolSession {
	const settings = Settings.isolated();
	settings.set("providers.webSearchOrder", order);
	settings.set("providers.webSearchExclude", excluded);
	return { settings, authStorage } as unknown as ToolSession;
}

/**
 * Let real candidate resolution run and record which provider it actually
 * reached. Only module LOADING is stubbed, so ordering, exclusion, and the
 * explicit/auto availability split are the code under test.
 */
function recordResolvedProviders(): { searched: SearchProviderId[]; explicitChecks: SearchProviderId[] } {
	const searched: SearchProviderId[] = [];
	const explicitChecks: SearchProviderId[] = [];
	vi.spyOn(provider, "getSearchProvider").mockImplementation(async (id: SearchProviderId) => ({
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => {
			explicitChecks.push(id);
			return true;
		},
		search: async () => {
			searched.push(id);
			return { provider: id, sources: [{ title: id, url: `https://example.com/${id}` }] };
		},
	}));
	return { searched, explicitChecks };
}

afterEach(() => {
	vi.restoreAllMocks();
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
});

describe("session-scoped web-search provider policy", () => {
	it("keeps one session's reloaded order out of a concurrent session's resolution", async () => {
		// B starts under its own settings; A then reloads a different order and
		// reapplies the process-wide globals, which is what `/refresh settings`
		// does. B must still resolve under its own settings.
		const sessionB = makeSession(["jina"]);
		const { searched } = recordResolvedProviders();

		await new WebSearchTool(sessionB).execute("b-before", { query: "anything" });

		setSearchProviderOrder(["brave"]);
		setExcludedSearchProviders(["jina"]);

		await new WebSearchTool(sessionB).execute("b-after", { query: "anything" });

		expect(searched).toEqual(["jina", "jina"]);
	});

	it("resolves two concurrent sessions under their own differing policies", async () => {
		const sessionA = makeSession(["brave"], ["jina"]);
		const sessionB = makeSession(["jina"], ["brave"]);
		const { searched } = recordResolvedProviders();

		await new WebSearchTool(sessionA).execute("a", { query: "anything" });
		await new WebSearchTool(sessionB).execute("b", { query: "anything" });

		expect(searched).toEqual(["brave", "jina"]);
	});

	it("applies a session's OWN reloaded order to its next search", async () => {
		// Guard against over-fixing: scoping the policy must not freeze it. A
		// refresh re-reads config into the SAME settings instance, so the next
		// search has to observe the new value.
		const session = makeSession(["jina"]);
		const { searched } = recordResolvedProviders();

		await new WebSearchTool(session).execute("before", { query: "anything" });

		session.settings.set("providers.webSearchOrder", ["brave"]);

		await new WebSearchTool(session).execute("after", { query: "anything" });

		expect(searched).toEqual(["jina", "brave"]);
	});

	it("applies a session's OWN reloaded exclusions to its next search", async () => {
		const session = makeSession(["jina", "brave"]);
		const { searched } = recordResolvedProviders();

		await new WebSearchTool(session).execute("before", { query: "anything" });

		session.settings.set("providers.webSearchExclude", ["jina"]);

		await new WebSearchTool(session).execute("after", { query: "anything" });

		expect(searched).toEqual(["jina", "brave"]);
	});

	it("still treats a session's hand-listed provider as an explicit selection", async () => {
		// The documented behaviour of a configured order: listed entries route
		// through `isExplicitlyAvailable`, so a provider with an unauthenticated
		// fallback is not silently skipped.
		const session = makeSession(["perplexity"]);
		const { searched, explicitChecks } = recordResolvedProviders();

		await new WebSearchTool(session).execute("explicit", { query: "anything" });

		expect(searched).toEqual(["perplexity"]);
		expect(explicitChecks).toEqual(["perplexity"]);
	});

	it("falls back to the process-wide policy for a caller with no settings of its own", async () => {
		// The one-shot CLI and embedding harnesses have no session settings;
		// they must keep resolving against the module-level policy.
		setSearchProviderOrder(["brave"]);
		const { searched } = recordResolvedProviders();

		await new WebSearchTool({ authStorage } as unknown as ToolSession).execute("cli", { query: "anything" });

		expect(searched).toEqual(["brave"]);
	});

	it("honours the calling session's exclusions in the Public Web fan-out", async () => {
		// The aggregate provider fans out over other providers itself, so its
		// exclusion filter needs the caller's policy rather than the global one.
		setExcludedSearchProviders([]);

		await expect(
			searchPublicWeb({
				query: "anything",
				systemPrompt: "",
				authStorage,
				providerPolicy: createSearchProviderPolicy([], ["startpage", "google", "duckduckgo", "ecosia", "mojeek"]),
			}),
		).rejects.toThrow(/excluded/);
	});
});
