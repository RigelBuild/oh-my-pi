import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffIsAffected, pathIsCodeRelevant } from "./ci-paths-affected";

describe("pathIsCodeRelevant", () => {
	it("matches directory-prefix patterns", () => {
		expect(pathIsCodeRelevant("packages/coding-agent/src/x.ts")).toBe(true);
		expect(pathIsCodeRelevant("crates/pi-natives/src/vcs.rs")).toBe(true);
		expect(pathIsCodeRelevant("scripts/release.ts")).toBe(true);
		expect(pathIsCodeRelevant(".github/workflows/ci.yml")).toBe(true);
		expect(pathIsCodeRelevant("types/assets/index.d.ts")).toBe(true);
	});

	it("matches exact-file patterns only on the whole path", () => {
		expect(pathIsCodeRelevant("package.json")).toBe(true);
		expect(pathIsCodeRelevant("Cargo.lock")).toBe(true);
		expect(pathIsCodeRelevant("bun.lock")).toBe(true);
		// An exact pattern must not match a same-named file in a subdirectory:
		// that is a package-local manifest, not the root one the matrix cares about.
		expect(pathIsCodeRelevant("sub/Cargo.toml")).toBe(false);
		expect(pathIsCodeRelevant("docs/package.json")).toBe(false);
	});

	it("gates on the config inputs the `check` job reads", () => {
		// A regression that loosens tsconfig or disables a lint rule must run the
		// matrix, not skip `check` and merge with `CI` green.
		expect(pathIsCodeRelevant("tsconfig.base.json")).toBe(true);
		expect(pathIsCodeRelevant("tsconfig.json")).toBe(true);
		expect(pathIsCodeRelevant("tsconfig.tools.json")).toBe(true);
		expect(pathIsCodeRelevant(".oxlintrc.json")).toBe(true);
		expect(pathIsCodeRelevant(".oxfmtrc.json")).toBe(true);
		// Cargo config and the bun workspace member both feed gated jobs (cargo
		// fetch/deny in `check`, `bun install --frozen-lockfile` in every job).
		expect(pathIsCodeRelevant(".cargo/config.toml")).toBe(true);
		expect(pathIsCodeRelevant("python/robomp/web/package.json")).toBe(true);
	});

	it("rejects non-code paths", () => {
		expect(pathIsCodeRelevant("docs/fork-resync.md")).toBe(false);
		expect(pathIsCodeRelevant("README.md")).toBe(false);
		expect(pathIsCodeRelevant("CHANGELOG.md")).toBe(false);
		expect(pathIsCodeRelevant(".gitignore")).toBe(false);
	});

	it("does not treat a prefix pattern as an exact match or vice versa", () => {
		// `packages` (no slash, no such file) must not match the directory.
		expect(pathIsCodeRelevant("packages")).toBe(false);
		// `LICENSE` is an exact file; `LICENSE-thing` is not it.
		expect(pathIsCodeRelevant("LICENSE-APACHE")).toBe(false);
		expect(pathIsCodeRelevant("LICENSE")).toBe(true);
	});
});

describe("diffIsAffected", () => {
	it("is true when any changed file is code-relevant", () => {
		expect(diffIsAffected(["docs/a.md", "packages/x/src/y.ts"])).toBe(true);
	});

	it("is false when every changed file is excluded", () => {
		expect(diffIsAffected(["docs/a.md", "README.md", "notes/plan.md"])).toBe(false);
	});

	it("is false for an empty array (main() treats this as doubt → fail-safe)", () => {
		// The pure predicate is false; main() overrides an empty *diff* to true.
		expect(diffIsAffected([])).toBe(false);
	});

	it("mixed docs+code PR runs the matrix", () => {
		expect(diffIsAffected(["docs/fork-resync.md", ".github/workflows/ci.yml"])).toBe(true);
	});
});

// End-to-end contract tests: drive the script's `main()` as a subprocess against
// a real temp git repo, exercising the git invocation + env contract where both
// fail-open bugs (rename detection, empty-diff, event/SHA fail-safes) live.
describe("main() end-to-end", () => {
	const scriptPath = join(import.meta.dir, "ci-paths-affected.ts");
	let repo: string;
	let outDir: string;
	let outFile: string;

	async function git(...args: string[]): Promise<void> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
		}
	}

	async function headSha(): Promise<string> {
		const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) {
			throw new Error(`git rev-parse HEAD failed: ${await new Response(proc.stderr).text()}`);
		}
		return out.trim();
	}

	async function commitAll(message: string): Promise<string> {
		await git("add", "-A");
		await git("commit", "-m", message);
		return headSha();
	}

	// Run main() as a subprocess and return the `affected=` value it wrote to
	// GITHUB_OUTPUT.
	async function runMain(env: Record<string, string>): Promise<string> {
		await Bun.write(outFile, "");
		const proc = Bun.spawn(["bun", scriptPath], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
		});
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`main() exited ${code}: ${await new Response(proc.stderr).text()}`);
		}
		const out = await Bun.file(outFile).text();
		const match = out.match(/^affected=(true|false)$/m);
		if (!match) throw new Error(`no affected= line in GITHUB_OUTPUT: ${JSON.stringify(out)}`);
		return match[1];
	}

	beforeAll(async () => {
		repo = await mkdtemp(join(tmpdir(), "ci-paths-"));
		// GITHUB_OUTPUT lives OUTSIDE the fixture repo: inside it, `git add -A`
		// would track it and it would show up in the diff under test.
		outDir = await mkdtemp(join(tmpdir(), "ci-paths-out-"));
		outFile = join(outDir, "gh_output");
		await git("init", "-q", "-b", "main");
		await Bun.write(join(repo, "packages/app/index.ts"), "export const x = 1;\n");
		await Bun.write(join(repo, "README.md"), "# base\n");
		await commitAll("base");
	});

	afterAll(async () => {
		await rm(repo, { recursive: true, force: true });
		await rm(outDir, { recursive: true, force: true });
	});

	it("a docs-only diff yields affected=false", async () => {
		const base = await headSha();
		await Bun.write(join(repo, "README.md"), "# changed\n");
		const head = await commitAll("docs change");
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: base, PR_HEAD_SHA: head })).toBe("false");
	});

	it("a code diff yields affected=true", async () => {
		const base = await headSha();
		await Bun.write(join(repo, "packages/app/index.ts"), "export const x = 2;\n");
		const head = await commitAll("code change");
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: base, PR_HEAD_SHA: head })).toBe("true");
	});

	// Regression for the rename fail-open: moving code OUT of a gated directory
	// must still run the matrix. Fails without `--no-renames` (git reports only
	// the docs destination), passes with it.
	it("a code→docs MOVE yields affected=true (rename fail-open guard)", async () => {
		const base = await headSha();
		await git("mv", "packages/app/index.ts", "README-moved.md");
		const head = await commitAll("move code to docs");
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: base, PR_HEAD_SHA: head })).toBe("true");
	});

	it("a push event always runs the matrix (fail-safe)", async () => {
		expect(await runMain({ GITHUB_EVENT_NAME: "push" })).toBe("true");
	});

	it("unset base/head SHA runs the matrix (fail-safe)", async () => {
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request" })).toBe("true");
	});

	it("a cargo-config change yields affected=true (F1 gated-input guard)", async () => {
		const base = await headSha();
		await Bun.write(join(repo, ".cargo/config.toml"), "[build]\n");
		const head = await commitAll("cargo config change");
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: base, PR_HEAD_SHA: head })).toBe("true");
	});

	it("an unresolvable base SHA runs the matrix (fail-safe)", async () => {
		const head = await headSha();
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: "0".repeat(40), PR_HEAD_SHA: head })).toBe(
			"true",
		);
	});

	it("an empty diff (same base and head) runs the matrix (fail-safe)", async () => {
		const head = await headSha();
		expect(await runMain({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: head, PR_HEAD_SHA: head })).toBe("true");
	});
});
