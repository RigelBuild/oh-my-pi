#!/usr/bin/env bun
/**
 * Decide whether a pull request touches paths that warrant the full CI matrix.
 *
 * ci.yml triggers on every pull_request (no `paths:` filter on the trigger),
 * so the required `CI` rollup always materializes even on a docs-only PR. This
 * script recreates the old trigger filter one level down: it reports whether
 * the PR's changed files touch any code-relevant path, and ci.yml gates the
 * expensive jobs (`check`, `native_addons`, and the test matrix that cascades
 * off it) on the result. A PR that touches only excluded paths (docs, prose)
 * skips those jobs — a skipped job reports success to branch protection — while
 * the cheap rollup still runs and posts `CI`.
 *
 * Fail-safe by construction: any doubt resolves to `affected=true` (run the
 * full matrix). A push/dispatch event, an unresolvable base ref, or a git
 * failure all fall through to `true`, so the only way to skip the heavy jobs is
 * a clean diff that provably touches no code path. A bug here can waste CI
 * minutes; it can never let untested code merge.
 */

import { appendFile } from "node:fs/promises";

/**
 * Path prefixes and exact files that require the full CI matrix. Started as the
 * `pull_request.paths` list ci.yml carried before the filter moved here, but a
 * gate is stricter than a trigger: a trigger that misses a path merely fails to
 * START a workflow (leaving the required check pending), whereas this gate lets
 * the paired job be SKIPPED and the rollup then excuses that skip. So it must
 * also list every input the gated jobs read — notably the root TS/lint config
 * the `check` job consumes (tsconfig*, oxlint/oxfmt config, the `types/` root),
 * or a config-only regression would skip `check` and merge with `CI` green.
 *
 * A trailing `/` marks a directory prefix; everything else is an exact file.
 * When in doubt, ADD a pattern: over-running the matrix wastes minutes; an
 * omission lets untested code merge. Adding a gated job to ci.yml means auditing
 * what it READS (its `run:` steps, its config files, its workspace members) and
 * adding those inputs here — a missed input is a silent skip, not a pending
 * check. Cargo config (`.cargo/`) and bun workspace members feed the `check` and
 * install steps, so they belong here even though the old trigger never listed
 * them.
 */
const CODE_PATHS: readonly string[] = [
	"packages/",
	"crates/",
	"scripts/",
	"bazel/",
	"patches/",
	".github/",
	"types/",
	".cargo/",
	"python/robomp/web/",
	"MODULE.bazel",
	"MODULE.bazel.lock",
	"BUILD.bazel",
	".bazelrc",
	".bazelignore",
	".bazelversion",
	"Cargo.toml",
	"Cargo.lock",
	"deny.toml",
	"about.toml",
	"LICENSE",
	"THIRD-PARTY-NOTICES.txt",
	"rust-toolchain.toml",
	"rustfmt.toml",
	"bun.lock",
	"bunfig.toml",
	"package.json",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.tools.json",
	".oxlintrc.json",
	".oxfmtrc.json",
];

/** Whether a single changed path matches any code-relevant pattern. */
export function pathIsCodeRelevant(path: string, patterns: readonly string[] = CODE_PATHS): boolean {
	for (const pattern of patterns) {
		if (pattern.endsWith("/")) {
			if (path.startsWith(pattern)) return true;
		} else if (path === pattern) {
			return true;
		}
	}
	return false;
}

/** Whether any changed path is code-relevant. Empty diff → not affected. */
export function diffIsAffected(changedPaths: readonly string[], patterns: readonly string[] = CODE_PATHS): boolean {
	return changedPaths.some(path => pathIsCodeRelevant(path, patterns));
}

async function changedFiles(baseSha: string, headSha: string): Promise<string[]> {
	// `--no-renames` is load-bearing: with git's default rename detection,
	// `--name-only` prints only a rename's DESTINATION, so moving code out of a
	// gated directory (e.g. packages/x.ts -> docs/x.md) would report only the
	// docs path and wrongly skip the matrix while deleting imported code.
	// Decomposing renames into delete+add makes the source path visible.
	const proc = Bun.spawn(["git", "diff", "--name-only", "--no-renames", "-z", `${baseSha}...${headSha}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`git diff ${baseSha}...${headSha} failed (exit ${code}): ${err.trim()}`);
	}
	return out.split("\0").filter(line => line.length > 0);
}

async function writeOutput(affected: boolean): Promise<void> {
	const line = `affected=${affected ? "true" : "false"}\n`;
	const target = process.env.GITHUB_OUTPUT;
	if (target) await appendFile(target, line);
	console.log(`affected=${affected}`);
}

async function main(): Promise<void> {
	const eventName = process.env.GITHUB_EVENT_NAME ?? "";
	// Only a pull_request can legitimately skip the matrix. Every other event
	// (push to main, release dispatch) always runs it.
	if (eventName !== "pull_request") {
		await writeOutput(true);
		return;
	}

	const baseSha = process.env.PR_BASE_SHA ?? "";
	const headSha = process.env.PR_HEAD_SHA ?? "";
	if (!baseSha || !headSha) {
		console.error("PR base/head SHA unset; running the full matrix (fail-safe).");
		await writeOutput(true);
		return;
	}

	try {
		const files = await changedFiles(baseSha, headSha);
		// An empty file list is doubt, not proof of "no code changed" — it is
		// equally the signature of a force-push race or a botched merge-base — so
		// fail safe and run the matrix. (diffIsAffected([]) is already false; the
		// explicit branch is what keeps that from becoming a silent skip.)
		if (files.length === 0) {
			console.error("empty diff (unexpected for a PR); running the full matrix (fail-safe).");
			await writeOutput(true);
			return;
		}
		await writeOutput(diffIsAffected(files));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`change detection failed; running the full matrix (fail-safe): ${message}`);
		await writeOutput(true);
	}
}

if (import.meta.main) await main();
