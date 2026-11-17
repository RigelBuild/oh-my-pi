import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import {
	applyCargoWorkspaceVersion,
	applyPackageVersion,
	bumpCanaryVersion,
	bumpVersion,
	isTransientGhError,
	latestReachableVersionTag,
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
});

describe("release reliability helpers", () => {
	test("accepts an explicit first release without a prior tag", () => {
		expect(resolveReleaseVersion("18.0.3", "")).toEqual({
			version: "18.0.3",
			note: "First release: no prior v* tag; releasing 18.0.3",
		});
	});

	test("allows only a truly tagless repository to prepare its first explicit version", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-tags-"));
		const git = (...args: string[]) => $`git ${args}`.cwd(repo).quiet();
		try {
			await git("init", "-b", "main");
			await git(
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-m",
				"initial",
			);
			const first = validateExplicitVersion("v18.0.3");
			if (first === null) throw new Error("expected a valid first release version");
			expect(resolveReleaseVersion(first, await latestReachableVersionTag(repo)).version).toBe("18.0.3");
			await git("tag", "v19.0.0");
			expect(await latestReachableVersionTag(repo)).toBe("v19.0.0");
			await git("checkout", "--orphan", "isolated");
			await git(
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-m",
				"isolated",
			);
			await expect(latestReachableVersionTag(repo)).rejects.toThrow("Version tags exist but none is reachable");
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	test("requires a prior tag for version bump keywords", () => {
		expect(() => resolveReleaseVersion("patch", "")).toThrow("no prior v* tag");
		expect(() => resolveReleaseVersion("canary", "")).toThrow("no prior v* tag");
	});

	test("rewrites package and workspace versions in process", () => {
		expect(applyPackageVersion('{"version": "1.0.0"}', "2.0.0")).toBe('{"version": "2.0.0"}');
		expect(applyCargoWorkspaceVersion('version = "1.0.0"\n', "2.0.0")).toBe('version = "2.0.0"\n');
	});

	test("retries transient GitHub failures until the request succeeds", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				async () => {
					attempts++;
					if (attempts < 3) throw new Error("HTTP 502 Bad Gateway");
					return "ok";
				},
				{ sleep: async () => {} },
			),
		).resolves.toBe("ok");
		expect(attempts).toBe(3);
	});

	test("retries transient GitHub CLI stderr", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				async () => {
					attempts++;
					if (attempts === 1) throw { message: "gh failed", stderr: Buffer.from("HTTP 503 Service Unavailable") };
					return "ok";
				},
				{ sleep: async () => {} },
			),
		).resolves.toBe("ok");
		expect(attempts).toBe(2);
	});

	test("caps transient GitHub retries", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				async () => {
					attempts++;
					throw new Error("HTTP 502 Bad Gateway");
				},
				{ sleep: async () => {} },
			),
		).rejects.toThrow("HTTP 502");
		expect(attempts).toBe(6);
	});

	test("does not retry permanent GitHub failures", async () => {
		let attempts = 0;
		await expect(
			runWithTransientRetry(
				async () => {
					attempts++;
					throw new Error("HTTP 404 Not Found");
				},
				{ sleep: async () => {} },
			),
		).rejects.toThrow("HTTP 404");
		expect(attempts).toBe(1);
		expect(isTransientGhError("HTTP 404 Not Found")).toBe(false);
	});
});
