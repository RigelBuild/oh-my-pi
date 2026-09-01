/**
 * Rule bucketing
 *
 * Single funnel that every discovered rule passes through on its way into a
 * session. It applies the user's disable levers, registers TTSR rules with the
 * manager, and splits the rest into the always-apply and rulebook buckets.
 *
 * Bucket precedence (matches docs/rulebook-matching-pipeline.md §5):
 *   1. TTSR     — non-empty `condition`/`astCondition` that `TtsrManager.addRule` accepts
 *   2. always   — `alwaysApply === true`
 *   3. rulebook — has a `description`
 */
import type { TtsrManager } from "../export/ttsr";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
	/**
	 * Names of the condition-bearing rules the TTSR manager consumed (holds) on
	 * this pass. An in-session refresh reconciles the manager against this set
	 * (`TtsrManager.retainRules`) to drop a rule deleted from disk or newly
	 * disabled; at init it is unused.
	 */
	ttsrRuleNames: Set<string>;
}

export interface BucketRulesOptions {
	/** Rule names to drop entirely (bundled defaults and user rules alike). */
	disabledRules?: readonly string[];
	/** When false, drop every rule from the bundled `builtin-defaults` provider. */
	builtinRules?: boolean;
}

/**
 * Filter and bucket rules, registering TTSR rules on `ttsrManager` as a side
 * effect. Disabled rules are dropped before any bucket assignment, so a
 * disabled rule is neither matched as TTSR nor surfaced via `rule://`.
 */
export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}

	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];
	const ttsrRuleNames = new Set<string>();

	for (const rule of rules) {
		if (disabled.has(rule.name)) continue;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) continue;

		// A TTSR-conditioned rule is "consumed" by the manager and must not also
		// appear in the rulebook/always buckets. On an in-session refresh the
		// manager is reused, so an EDITED rule keeps its name: a plain `addRule`
		// would no-op on the existing name and leave the STALE compiled
		// conditions/scope/globs live (still matched, still republished via
		// `rule://`). `addOrUpdateRule` recompiles a surviving entry whose
		// TTSR-relevant content changed while preserving its injection state, and
		// registers a brand-new rule on first sight. It returns membership (like
		// `hasRule`): true when the rule is monitored after the call, false when
		// its conditions/scope were rejected — that rule then falls through to the
		// buckets below, exactly as at init.
		const hasTtsrCondition =
			(rule.condition && rule.condition.length > 0) || (rule.astCondition && rule.astCondition.length > 0);
		if (hasTtsrCondition) {
			if (ttsrManager.addOrUpdateRule(rule)) {
				ttsrRuleNames.add(rule.name);
				continue;
			}
		}
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	return { rulebookRules, alwaysApplyRules, ttsrRuleNames };
}
