// Config for scripts/agent-prompt-pattern-gate.ts.
//
// Agent prompts must not ask the model to show its reasoning. This gate
// fails when a scoped file holds a banned phrase on a line that is not a
// config key. Render with `cue export` into agent-prompt-pattern-gate.config.json.
package gate

#Config: {
	// Globs of files to scan, relative to the repo root.
	globs: [string, ...string]
	// Globs of files to skip even when a glob matches them.
	excludeGlobs: [...string]
	// Case-insensitive RE2 pattern. A line matching it is a finding.
	pattern: string & !=""
	// Regexes whose matches are blanked before `pattern` runs, so a config
	// key that carries a banned word (for example `reasoning_effort`) is not
	// a finding.
	configKeys: [...string]
	// Repo-relative paths (path:line) that are reviewed and allowed.
	exceptions: [...string]
}

config: #Config & {
	globs: [
		"packages/*/src/prompts/**",
		"packages/coding-agent/src/extensibility/custom-commands/bundled/**",
		".omp/skills/**/SKILL.md",
		"docs/skills/**/SKILL.md",
		"AGENTS.md",
	]
	excludeGlobs: ["**/node_modules/**", "packages/catalog/src/compat/rules/**"]
	pattern: #"(?i)reasoning|chain of thought|chain-of-thought|thinking process|your thought process|explain (your|how you)|walk (me )?through (your|how)|show your work|step[- ]by[- ]step|think (out loud|aloud)|internal monologue|scratchpad"#
	configKeys: [
		#"(?i)^\s*["']?(?:reasonin[g]_effort|thinking[-_]level|thinkingLevel|disableReasoning)["']?\s*:"#,
		#"^\s*--reasonin[g](?:[= ]|$)"#,
	]
	exceptions: []
}
