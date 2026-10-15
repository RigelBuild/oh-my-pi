import { describe, expect, test } from "bun:test";
import { enumerateChangelogVersions, mergePackageSection, selectPublishedFloorTag } from "./ci-release-notes";

describe("release note changelog versions", () => {
	test("captures tracking release section versions and merges only the requested range", () => {
		const changelog = [
			"## [Unreleased]",
			"## [18.9.2-rigel.3] - 2026-10-15",
			"### Added",
			"- tracking three",
			"## [18.9.2-rigel.2] - 2026-10-14",
			"### Added",
			"- tracking two",
			"## [18.9.2-rigel.1] - 2026-10-13",
			"### Added",
			"- tracking one",
			"## [18.9.2] - 2026-10-12",
			"### Added",
			"- stable release",
		].join("\n");

		expect(enumerateChangelogVersions(changelog).map(span => span.version)).toEqual([
			"18.9.2-rigel.3",
			"18.9.2-rigel.2",
			"18.9.2-rigel.1",
			"18.9.2",
		]);
		expect(mergePackageSection(changelog, "18.9.2-rigel.1", "18.9.2-rigel.3")).toContain(
			"- tracking three\n- tracking two",
		);
		expect(mergePackageSection(changelog, "18.9.2-rigel.1", "18.9.2-rigel.3")).not.toContain("tracking one");
		expect(mergePackageSection(changelog, "18.9.2-rigel.1", "18.9.2-rigel.3")).not.toContain("stable release");
	});
});

describe("published release notes floor", () => {
	const releases = [
		{ tagName: "v18.9.1", isDraft: false, isPrerelease: false },
		{ tagName: "v18.9.2-rigel.1", isDraft: false, isPrerelease: true },
		{ tagName: "v18.9.2-rigel.2", isDraft: false, isPrerelease: true },
		{ tagName: "v18.9.2-rigel.3", isDraft: true, isPrerelease: true },
		{ tagName: "v18.9.2-canary.8", isDraft: false, isPrerelease: true },
		{ tagName: "v18.9.3", isDraft: false, isPrerelease: false },
	];

	test("uses the prior published rigel release for a tracking target", () => {
		expect(selectPublishedFloorTag("18.9.2-rigel.3", releases)).toBe("18.9.2-rigel.2");
	});

	test("keeps stable targets on the prior stable release floor", () => {
		expect(selectPublishedFloorTag("18.9.2", releases)).toBe("18.9.1");
	});
});
