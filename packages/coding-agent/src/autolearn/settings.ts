/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
// Master flag is default-off → inert (read live at every stop); sub-flags gate behaviour.
export const cfgAutolearnEnabled = register({
	id: "autolearn.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Auto-Learn",
		label: "Auto-Learn (experimental)",
		description:
			"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills",
	},
});

export const cfgAutolearnAutoContinue = register({
	id: "autolearn.autoContinue",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Auto-Learn",
		label: "Auto-run capture at stop",
		description:
			"When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.",
		condition: "autolearnActive",
	},
});

// Config-file-only knob (numbers without `options` are hidden from the UI).
export const cfgAutolearnMinToolCalls = register({ id: "autolearn.minToolCalls", type: "number", default: 5 });

// Capture routing and journal-only mode (config-file-only; empty = default behaviour).
/** Model role the capture turn runs on. Unknown or unavailable role skips capture; never the seat's model. */
export const cfgAutolearnCaptureRole = register({ id: "autolearn.captureRole", type: "string", default: undefined });
/** File whose text replaces the bundled capture prompt. Unreadable file skips capture. */
export const cfgAutolearnCapturePrompt = register({
	id: "autolearn.capturePrompt",
	type: "string",
	default: undefined,
});
/** Replay above this many tokens becomes a digest that fits the cap. */
export const cfgAutolearnCaptureMaxInputTokens = register({
	id: "autolearn.captureMaxInputTokens",
	type: "number",
	default: undefined,
});
/** Journal-only mode: `manage_skill` writes one lesson file here instead of a managed skill. */
export const cfgAutolearnJournalDir = register({ id: "autolearn.journalDir", type: "string", default: undefined });

export const DEFAULT_AUTOLEARN_SECRET_PATTERNS: readonly string[] = [
	"ghp_",
	"github_pat_",
	"glpat-",
	"lin_api_",
	"sk-",
	"xox[abp]-",
	"AKIA",
	"AIza",
	"eyJ[A-Za-z0-9_-]+\\.eyJ",
	"-----BEGIN",
];
/** Journal lessons matching any of these regular expressions are refused before any write. */
export const cfgAutolearnSecretPatterns = register({
	id: "autolearn.secretPatterns",
	type: "array",
	default: DEFAULT_AUTOLEARN_SECRET_PATTERNS,
});
