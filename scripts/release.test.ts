import { describe, expect, test } from "bun:test";
import {
	applyCargoWorkspaceVersion,
	applyNativesSentinel,
	applyPackageVersion,
	bumpCanaryVersion,
	bumpVersion,
	ghErrorText,
	isTransientGhError,
	resolveReleaseVersion,
	runWithTransientRetry,
	validateExplicitVersion,
} from "./release";

describe("validateExplicitVersion", () => {
	test("rejects malformed versions", () => {
		expect(validateExplicitVersion("999.bad")).toBe(null);
		expect(validateExplicitVersion("17")).toBe(null);
		expect(validateExplicitVersion("17.2")).toBe(null);
		expect(validateExplicitVersion("17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("v17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("abc")).toBe(null);
		expect(validateExplicitVersion("")).toBe(null);
		expect(validateExplicitVersion("v")).toBe(null);
		expect(validateExplicitVersion("17.2.8-")).toBe(null);
	});

	test("rejects leading zeroes in numeric segments", () => {
		expect(validateExplicitVersion("018.0.0")).toBe(null);
		expect(validateExplicitVersion("v018.0.0")).toBe(null);
		expect(validateExplicitVersion("18.00.0")).toBe(null);
		expect(validateExplicitVersion("18.0.00")).toBe(null);
	});

	test("rejects prerelease suffixes (not supported by this release path)", () => {
		// Prereleases would be published as npm `latest` because the downstream
		// publish runs `npm publish` with no `--tag`.
		expect(validateExplicitVersion("17.2.8-rc.1")).toBe(null);
		expect(validateExplicitVersion("v17.2.8-beta")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha.1.2")).toBe(null);
		expect(validateExplicitVersion("1.0.0-0.3.7")).toBe(null);
		expect(validateExplicitVersion("1.0.0-x.7.z.92")).toBe(null);
	});

	test("accepts bare three-segment numeric versions and returns them unchanged", () => {
		expect(validateExplicitVersion("17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("0.0.0")).toBe("0.0.0");
		expect(validateExplicitVersion("1.0.0")).toBe("1.0.0");
	});

	test("accepts leading v prefix and normalizes to the bare version", () => {
		expect(validateExplicitVersion("v17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("V17.2.8")).toBe(null);
	});
});

describe("watchCI transient retry", () => {
	test("isTransientGhError flags transient GitHub API failures", () => {
		expect(isTransientGhError("failed to get runs: HTTP 502: Server Error (https://api.github.com/...)")).toBe(true);
		expect(isTransientGhError("failed to get runs: HTTP 503: Server Error")).toBe(true);
		expect(isTransientGhError("failed to get runs: HTTP 504: Server Error")).toBe(true);
	});

	test("isTransientGhError does not flag genuine non-transient errors", () => {
		expect(isTransientGhError("gh: Not Found (HTTP 404)")).toBe(false);
		expect(isTransientGhError("authentication required")).toBe(false);
		expect(isTransientGhError("")).toBe(false);
	});

	test("runWithTransientRetry resolves after transient errors clear", async () => {
		let attempts = 0;
		const result = await runWithTransientRetry(
			() => {
				attempts++;
				if (attempts <= 2) throw new Error("HTTP 502: Server Error");
				return Promise.resolve("ok");
			},
			{ sleep: () => Promise.resolve() },
		);
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	test("runWithTransientRetry rethrows immediately on a non-transient error", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				() => {
					attempts++;
					return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
				},
				{ sleep: () => Promise.resolve() },
			),
		).rejects.toThrow("HTTP 404");
		expect(attempts).toBe(1);
	});

	test("runWithTransientRetry gives up after maxRetries on a persistent transient error", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				() => {
					attempts++;
					return Promise.reject(new Error("HTTP 502: Server Error"));
				},
				{ maxRetries: 3, sleep: () => Promise.resolve() },
			),
		).rejects.toThrow("HTTP 502");
		expect(attempts).toBe(4);
	});

	test("ghErrorText surfaces stderr from a Bun ShellError whose message is only the exit code", () => {
		// Bun's `$` throws a ShellError with message "Failed with exit code N" and
		// the real gh diagnostic on the stderr buffer. Reading .message alone would
		// miss the HTTP status entirely.
		const shellError = {
			message: "Failed with exit code 1",
			stderr: Buffer.from("failed to get runs: HTTP 502: Server Error\n"),
			stdout: Buffer.from(""),
		};
		const text = ghErrorText(shellError);
		expect(text).toContain("HTTP 502");
		expect(isTransientGhError(text)).toBe(true);
	});

	test("runWithTransientRetry retries a ShellError-shaped transient failure", async () => {
		// The end-to-end contract: a thrown ShellError (message = exit code, real
		// error on stderr) must be classified transient and retried, not rethrown
		// on the first attempt. Pre-fix this rethrew immediately (attempts === 1).
		let attempts = 0;
		const result = await runWithTransientRetry(
			() => {
				attempts++;
				if (attempts <= 2) {
					throw {
						message: "Failed with exit code 1",
						stderr: Buffer.from("failed to get runs: HTTP 502: Server Error\n"),
						stdout: Buffer.from(""),
					};
				}
				return Promise.resolve("ok");
			},
			{ sleep: () => Promise.resolve() },
		);
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});
});

describe("release version bumps", () => {
	test("starts a canary patch release after the current stable version", () => {
		expect(bumpCanaryVersion("0.13.0")).toBe("0.13.1-canary.1");
	});

	test("increments the existing canary release number", () => {
		expect(bumpCanaryVersion("0.13.0-canary.2")).toBe("0.13.0-canary.3");
	});

	test("finalizes a canary with a patch bump", () => {
		expect(bumpVersion("0.13.0-canary.2", "patch")).toBe("0.13.0");
	});

	test("bumps the core version when applying a minor bump to a canary", () => {
		expect(bumpVersion("0.13.0-canary.2", "minor")).toBe("0.14.0");
	});

	test("rejects explicit canary versions", () => {
		expect(validateExplicitVersion("1.2.3-canary.1")).toBe(null);
	});
});

describe("resolveReleaseVersion", () => {
	test("releases an explicit version on a tagless first-release repo", () => {
		// The bug: a freshly reset/created fork has no `v*` tag, so `git describe`
		// exits non-zero and `latestTag` is "". The explicit first release must
		// still resolve — not crash and not be gated on a nonexistent prior tag.
		expect(resolveReleaseVersion("18.0.3", "")).toEqual({
			version: "18.0.3",
			note: "First release: no prior v* tag; releasing 18.0.3",
		});
	});

	test("accepts an explicit version strictly greater than the latest tag", () => {
		expect(resolveReleaseVersion("18.0.4", "v18.0.3")).toEqual({
			version: "18.0.4",
			note: "Version 18.0.4 > v18.0.3",
		});
	});

	test("rejects an explicit version not greater than the latest tag", () => {
		expect(() => resolveReleaseVersion("18.0.3", "v18.0.3")).toThrow(
			"Version 18.0.3 must be greater than latest tag v18.0.3",
		);
		expect(() => resolveReleaseVersion("18.0.2", "v18.0.3")).toThrow();
	});

	test("derives a bump from the latest tag", () => {
		expect(resolveReleaseVersion("patch", "v18.0.3")).toEqual({
			version: "18.0.4",
			note: "Bumping patch version from v18.0.3 -> 18.0.4",
		});
		expect(resolveReleaseVersion("minor", "v18.0.3").version).toBe("18.1.0");
		expect(resolveReleaseVersion("major", "v18.0.3").version).toBe("19.0.0");
	});

	test("refuses a bump keyword when there is no prior tag to derive from", () => {
		expect(() => resolveReleaseVersion("patch", "")).toThrow("cannot patch-bump with no prior v* tag");
		expect(() => resolveReleaseVersion("minor", "")).toThrow("cannot minor-bump with no prior v* tag");
		expect(() => resolveReleaseVersion("major", "")).toThrow("cannot major-bump with no prior v* tag");
	});

	test("refuses a canary when there is no prior tag", () => {
		expect(() => resolveReleaseVersion("canary", "")).toThrow("cannot cut a canary with no prior v* tag");
	});

	test("derives a canary from the latest tag", () => {
		expect(resolveReleaseVersion("canary", "v0.13.0")).toEqual({
			version: "0.13.1-canary.1",
			note: "Bumping canary version from v0.13.0 -> 0.13.1-canary.1",
		});
	});
});

describe("applyPackageVersion", () => {
	test("rewrites the top-level version and leaves nested dependency ranges alone", () => {
		const raw = `{\n\t"name": "@oh-my-pi/coding-agent",\n\t"version": "18.0.3",\n\t"dependencies": {\n\t\t"@oh-my-pi/ai": "18.0.3",\n\t\t"zod": "3.24.1"\n\t}\n}\n`;
		const out = applyPackageVersion(raw, "18.0.4");
		expect(out).toContain(`"version": "18.0.4"`);
		// Dependency ranges are not `"version": "…"` keys, so they must survive.
		expect(out).toContain(`"@oh-my-pi/ai": "18.0.3"`);
		expect(out).toContain(`"zod": "3.24.1"`);
	});
});

describe("applyCargoWorkspaceVersion", () => {
	test("rewrites the line-anchored workspace version, not member crate lines", () => {
		const raw = `[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "18.0.3"\nedition = "2024"\n`;
		const out = applyCargoWorkspaceVersion(raw, "18.0.4");
		expect(out).toContain(`\nversion = "18.0.4"\n`);
		expect(out).toContain(`edition = "2024"`);
	});

	test("does not touch an indented version key (member crates use version.workspace)", () => {
		const raw = `[package]\n  version = "0.1.0"\nversion = "18.0.3"\n`;
		const out = applyCargoWorkspaceVersion(raw, "18.0.4");
		expect(out).toContain(`  version = "0.1.0"`);
		expect(out).toContain(`\nversion = "18.0.4"\n`);
	});
});

describe("applyNativesSentinel", () => {
	test("rewrites the sentinel token in its surrounding syntax", () => {
		const raw = `#[napi(js_name = "__piNativesV18_0_3")]\npub fn sentinel() {}\n`;
		expect(applyNativesSentinel(raw, "__piNativesV18_0_4")).toContain(`js_name = "__piNativesV18_0_4"`);
	});

	test("is idempotent when the token already matches", () => {
		const raw = `export const __piNativesV18_0_4: () => void;\n`;
		expect(applyNativesSentinel(raw, "__piNativesV18_0_4")).toBe(raw);
	});

	test("rewrites every occurrence in an index.js-shaped binding (global flag is load-bearing)", () => {
		// packages/natives/native/index.js binds the export to its native source
		// on one line, so the token appears twice and both must move.
		const raw = `export const __piNativesV18_0_3 = nativeBindings.__piNativesV18_0_3;\n`;
		const out = applyNativesSentinel(raw, "__piNativesV18_0_4");
		expect(out).not.toContain("__piNativesV18_0_3");
		expect(out.match(/__piNativesV18_0_4/g)).toHaveLength(2);
	});
});
