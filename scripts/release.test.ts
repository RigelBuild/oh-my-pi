import { describe, expect, test } from "bun:test";
import {
	applyCargoWorkspaceVersion,
	applyNativesSentinel,
	applyPackageVersion,
	bumpCanaryVersion,
	bumpVersion,
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

describe("release reliability helpers", () => {
	test("resolves an explicit first release without a tag", () => {
		expect(resolveReleaseVersion("18.0.3", "")).toEqual({
			version: "18.0.3",
			note: expect.stringContaining("First release"),
		});
	});
	test("rewrites release targets in process", () => {
		expect(applyPackageVersion('{"version": "1.0.0"}', "2.0.0")).toBe('{"version": "2.0.0"}');
		expect(applyCargoWorkspaceVersion('version = "1.0.0"\n', "2.0.0")).toBe('version = "2.0.0"\n');
		expect(applyNativesSentinel("__piNativesV1 __piNativesV1", "__piNativesV2")).toBe("__piNativesV2 __piNativesV2");
	});
	test("retries transient API failures and stops on non-transient", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				async () => {
					attempts++;
					if (attempts < 3) throw new Error("HTTP 502");
					return "ok";
				},
				{ sleep: async () => {} },
			),
		).resolves.toBe("ok");
		expect(attempts).toBe(3);
		expect(isTransientGhError("HTTP 404 Not Found")).toBe(false);
	});
});
