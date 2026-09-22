import { describe, expect, test } from "bun:test";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Claude Opus 5.5 ships three behavior changes the previous Opus generations
// do not have, each encoded in `classes/anthropic.kdl` rather than hand-edited
// into models.json:
//
//   1. Signed thinking is bound to the exact preceding conversation, as with
//      Fable/Mythos 5.1 (`thinking-prefix-binding`). Lineage-wide.
//   2. The hosts exposing Anthropic's binding controls expose them here too
//      (`supports-thinking-binding-controls`), same host set as Fable 5.1.
//   3. Forced tool choice (`tool_choice` `any`/`tool`) is rejected on every
//      Anthropic-messages host, so the axis is scoped by `on-api` rather than
//      an enumerated provider list.
//
// Synthetic specs, so the rule assertions hold regardless of what upstream
// metadata the bundled snapshot happens to carry: test the rule, not the
// generated JSON.
function spec(id: string, overrides: Partial<ModelSpec<"anthropic-messages">> = {}) {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

/** Every first-party/gateway host that routes Opus 5.5 over anthropic-messages. */
const ANTHROPIC_MESSAGES_HOSTS: [provider: string, id: string, baseUrl: string][] = [
	["anthropic", "claude-opus-5-5", "https://api.anthropic.com"],
	["cloudflare-ai-gateway", "anthropic/claude-opus-5-5", "https://gateway.ai.cloudflare.com/v1/a/g/anthropic"],
	["google-vertex", "claude-opus-5-5@default", "https://us-east5-aiplatform.googleapis.com"],
	["opencode-zen", "claude-opus-5-5", "https://opencode.ai/zen/v1"],
	["vercel-ai-gateway", "anthropic/claude-opus-5.5", "https://ai-gateway.vercel.sh/v1"],
	["zenmux", "anthropic/claude-opus-5.5", "https://zenmux.ai/api/v1"],
];

/** The hosts whose deployment exposes Anthropic's thinking binding controls. */
const EXPOSES_BINDING_CONTROLS: Record<string, true> = {
	anthropic: true,
	"cloudflare-ai-gateway": true,
	"google-vertex": true,
};

describe("Claude Opus 5.5 compat policy", () => {
	test("forced tool choice is refused on every anthropic-messages host", () => {
		for (const [provider, id, baseUrl] of ANTHROPIC_MESSAGES_HOSTS) {
			const policy = resolveModelPolicy(spec(id, { provider, baseUrl }));
			expect(`${provider}: ${policy.compat.supportsForcedToolChoice}`).toBe(`${provider}: false`);
		}
	});

	test("thinking is prefix-bound across the lineage", () => {
		for (const [provider, id, baseUrl] of ANTHROPIC_MESSAGES_HOSTS) {
			const policy = resolveModelPolicy(spec(id, { provider, baseUrl }));
			expect(`${provider}: ${policy.thinking?.prefixBinding}`).toBe(`${provider}: true`);
		}
	});

	test("binding controls follow the host, matching the Fable 5.1 host set", () => {
		for (const [provider, id, baseUrl] of ANTHROPIC_MESSAGES_HOSTS) {
			const policy = resolveModelPolicy(spec(id, { provider, baseUrl }));
			expect(`${provider}: ${policy.compat.supportsThinkingBindingControls}`).toBe(
				`${provider}: ${EXPOSES_BINDING_CONTROLS[provider] === true}`,
			);
		}
	});

	test("earlier Opus revisions keep forced tool choice and are not prefix-bound", () => {
		for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"]) {
			const policy = resolveModelPolicy(spec(id));
			expect(`${id}: forced=${policy.compat.supportsForcedToolChoice}`).toBe(`${id}: forced=true`);
			expect(`${id}: prefix=${policy.thinking?.prefixBinding}`).toBe(`${id}: prefix=undefined`);
		}
	});

	// Venice spells Opus 4.5 `claude-opus-45`, which revision extraction reads
	// as `45.0.0`. An open-ended `>=5.5` would capture that 4.5 model and hand
	// it Opus 5.5's breaking behavior, so the rules carry a `<45` upper bound.
	test("the dotless Venice Opus 4.5 id is not swept in by the revision range", () => {
		const policy = resolveModelPolicy(
			spec("claude-opus-45", { provider: "venice", baseUrl: "https://api.venice.ai/api/v1" }),
		);
		expect(policy.identity.revision).toBe("45.0.0");
		expect(policy.thinking?.prefixBinding).toBeUndefined();
	});
});

describe("Claude Opus 5.5 bundled row", () => {
	// `getProviderModels` consumes models.json verbatim and never reruns
	// `buildModel`, so an offline/static startup reports whatever the committed
	// row says — the rules only reach users once the row is regenerated.
	function bundled() {
		const model = getBundledModels("anthropic").find(candidate => candidate.id === "claude-opus-5-5");
		if (!model) throw new Error("anthropic/claude-opus-5-5 is not bundled");
		return model;
	}

	test("ships Anthropic's published pricing and limits", () => {
		const model = bundled();
		expect(model.cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
	});

	test("bakes the three compat corrections into the committed row", () => {
		const model = bundled();
		expect(model.compat).toMatchObject({
			supportsForcedToolChoice: false,
			supportsThinkingBindingControls: true,
		});
		expect(model.thinking?.prefixBinding).toBe(true);
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		expect(
			model.compat && "requiresThinkingEnabled" in model.compat ? model.compat.requiresThinkingEnabled : false,
		).toBe(true);
	});

	test("is the Anthropic provider default and resolves from the bundle", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.anthropic).toBe("claude-opus-5-5");
		expect(getBundledModels("anthropic").some(model => model.id === DEFAULT_MODEL_PER_PROVIDER.anthropic)).toBe(true);
	});
});
