import { describe, expect, it } from "bun:test";
import { diffIsAffected, pathIsCodeRelevant } from "./ci-paths-affected";

describe("pathIsCodeRelevant", () => {
	it("matches directory-prefix patterns", () => {
		expect(pathIsCodeRelevant("packages/coding-agent/src/x.ts")).toBe(true);
		expect(pathIsCodeRelevant("crates/pi-natives/src/vcs.rs")).toBe(true);
		expect(pathIsCodeRelevant("scripts/release.ts")).toBe(true);
		expect(pathIsCodeRelevant(".github/workflows/ci.yml")).toBe(true);
	});

	it("matches exact-file patterns only on the whole path", () => {
		expect(pathIsCodeRelevant("package.json")).toBe(true);
		expect(pathIsCodeRelevant("Cargo.lock")).toBe(true);
		expect(pathIsCodeRelevant("bun.lock")).toBe(true);
		// An exact pattern must not match a same-named file in a subdirectory:
		// that is a package-local manifest, not the root one the matrix cares about.
		expect(pathIsCodeRelevant("packages/foo/package.json")).toBe(true); // still true via packages/ prefix
		expect(pathIsCodeRelevant("docs/package.json")).toBe(false);
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

	it("is false for an empty diff", () => {
		expect(diffIsAffected([])).toBe(false);
	});

	it("mixed docs+code PR runs the matrix", () => {
		expect(diffIsAffected(["docs/fork-resync.md", ".github/workflows/ci.yml"])).toBe(true);
	});
});
