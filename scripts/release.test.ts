import { describe, expect, test } from "bun:test";
import { bumpCanaryVersion, bumpVersion, resolveReleaseVersion, validateExplicitVersion } from "./release";

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
