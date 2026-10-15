#!/usr/bin/env bun

/**
 * Generate aggregated release notes from per-package CHANGELOG.md files.
 *
 * Walks the version range `(latest-published-release, target]` so changelog
 * sections finalized under intervening *silent* tags (a `vX.Y.Z` tag that
 * exists on the remote but has no GitHub Release — most often because a CI
 * concurrency-cancel killed the publish job, #2596 / #2564) are rolled into
 * the next published release body. Sections are grouped by `package.json`
 * `name`, then merged per `### <category>` bullet bucket. Bullet lines are
 * deduplicated by exact trimmed text so post-release changelog flattening
 * (`fix-changelogs`) does not surface the same entry twice. Sections without
 * entries are skipped.
 *
 * Usage:
 *   bun scripts/ci-release-notes.ts                     # writes release-notes.md
 *   bun scripts/ci-release-notes.ts v15.4.3             # explicit tag/version
 *   bun scripts/ci-release-notes.ts 15.4.3 notes.md     # custom output path
 *
 * The lower bound is resolved by `gh release list`. Set
 * `OMP_RELEASE_NOTES_FLOOR=v15.12.4` to override (empty string forces
 * single-version mode, matching the pre-#2596 behavior). `OMP_REPO` /
 * `GITHUB_REPOSITORY` control the queried repo.
 *
 * Intended for the `release_github` CI job: the output is passed to
 * `softprops/action-gh-release` via `body_path:`. The action's
 * `generate_release_notes: true` still appends the auto-generated PR list
 * underneath; this only adds curated context.
 */

import { $, Glob } from "bun";
import { compareVersions } from "../packages/utils/src/version";
import { parseTrackingVersion } from "./release-tag";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const REPO = process.env.OMP_REPO ?? process.env.GITHUB_REPOSITORY ?? "can1357/oh-my-pi";

// Canonical ordering used by `fix-changelogs`; unknown categories sort
// alphabetically after these.
const CATEGORY_ORDER = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;

export interface ChangelogVersionSpan {
	version: string;
	/** 0-indexed line of the `## [X.Y.Z]` heading. */
	start: number;
	/** 0-indexed line just past the last line of this version's body (exclusive). */
	end: number;
}

/**
 * Locate every `## [X.Y.Z]` or `## [X.Y.Z-rigel.N]` heading and compute its
 * span up to the next `## [` heading. Other headings still end the prior span.
 */
export function enumerateChangelogVersions(content: string): ChangelogVersionSpan[] {
	const lines = content.split("\n");
	const spans: ChangelogVersionSpan[] = [];
	const headingIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## [")) headingIdx.push(i);
	}
	for (const idx of headingIdx) {
		const match = lines[idx].match(/^## \[(\d+\.\d+\.\d+(?:-[^\]]+)?)\]/);
		if (!match) continue;
		const version = match[1];
		if (!/^\d+\.\d+\.\d+$/.test(version) && !parseTrackingVersion(version)) continue;
		const nextIdx = headingIdx.find(j => j > idx) ?? lines.length;
		spans.push({ version, start: idx, end: nextIdx });
	}
	return spans;
}

/**
 * Merge `(floorExclusive, targetInclusive]` version sections from a single
 * package's changelog into one combined body, grouped by `### <category>`.
 *
 * Versions iterate newest → oldest so newer phrasing wins when a bullet was
 * flattened forward by `fix-changelogs` and ends up in both sections.
 * `floorExclusive === null` → take only the target version (legacy behavior).
 * Returns "" when no in-range version contributes any bullet.
 */
export function mergePackageSection(content: string, floorExclusive: string | null, targetInclusive: string): string {
	const spans = enumerateChangelogVersions(content)
		.filter(v => {
			if (compareVersions(v.version, targetInclusive) > 0) return false;
			if (floorExclusive === null) return compareVersions(v.version, targetInclusive) === 0;
			return compareVersions(v.version, floorExclusive) > 0;
		})
		.sort((a, b) => compareVersions(b.version, a.version));
	if (spans.length === 0) return "";

	const lines = content.split("\n");
	const seenCategories: string[] = []; // first-seen order
	const buckets = new Map<string, string[]>();
	const seenLines = new Set<string>();

	for (const span of spans) {
		let currentCat: string | null = null;
		let buf: string[] = [];
		const flushCurrent = () => {
			if (currentCat === null || buf.length === 0) return;
			let bucket = buckets.get(currentCat);
			if (!bucket) {
				bucket = [];
				buckets.set(currentCat, bucket);
				seenCategories.push(currentCat);
			}
			for (const line of buf) {
				const key = line.trim();
				if (key.length === 0) continue;
				if (seenLines.has(key)) continue;
				seenLines.add(key);
				bucket.push(line);
			}
		};
		// Skip the `## [X.Y.Z]` heading line itself.
		for (let i = span.start + 1; i < span.end; i++) {
			const line = lines[i];
			const catMatch = line.match(/^### (.+?)\s*$/);
			if (catMatch) {
				flushCurrent();
				currentCat = catMatch[1];
				buf = [];
				continue;
			}
			// Pre-category prose (rare; usually blank padding) is dropped — there
			// is no surrounding `###` to attribute it to in the merged output.
			if (currentCat === null) continue;
			buf.push(line);
		}
		flushCurrent();
	}

	if (seenCategories.length === 0) return "";

	seenCategories.sort((a, b) => {
		const ai = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number]);
		const bi = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number]);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});

	const out: string[] = [];
	for (const cat of seenCategories) {
		const bucket = buckets.get(cat) ?? [];
		// Collapse runs of blank lines and strip trailing blanks per bucket.
		const collapsed: string[] = [];
		let prevBlank = false;
		for (const line of bucket) {
			const blank = line.trim().length === 0;
			if (blank && prevBlank) continue;
			collapsed.push(line);
			prevBlank = blank;
		}
		while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim().length === 0) {
			collapsed.pop();
		}
		if (collapsed.length === 0) continue;
		out.push(`### ${cat}`, "", ...collapsed, "");
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

async function loadPackageName(pkgDir: string): Promise<string> {
	try {
		const pkg = (await Bun.file(`${pkgDir}/package.json`).json()) as { name?: unknown };
		return typeof pkg.name === "string" ? pkg.name : pkgDir;
	} catch {
		return pkgDir;
	}
}

interface PublishedRelease {
	tagName?: unknown;
	isDraft?: unknown;
	isPrerelease?: unknown;
}

/** Select the latest published release below the target, including rigel releases for rigel targets. */
export function selectPublishedFloorTag(targetVersion: string, releases: readonly PublishedRelease[]): string | null {
	const trackingTarget = parseTrackingVersion(targetVersion) !== null;
	const candidates = releases
		.filter(release => release.isDraft !== true)
		.map(release => ({
			release,
			tag: typeof release.tagName === "string" ? release.tagName : "",
		}))
		.filter(({ release, tag }) => {
			if (!tag.startsWith("v")) return false;
			const version = tag.slice(1);
			if (trackingTarget && parseTrackingVersion(version)) return compareVersions(version, targetVersion) < 0;
			return (
				release.isPrerelease !== true &&
				/^\d+\.\d+\.\d+$/.test(version) &&
				compareVersions(version, targetVersion) < 0
			);
		})
		.map(({ tag }) => tag)
		.sort((a, b) => compareVersions(b, a));
	return candidates[0]?.replace(/^v/, "") ?? null;
}

/**
 * Resolve the release-notes floor via `gh release list`.
 * `OMP_RELEASE_NOTES_FLOOR` overrides (`""` forces null). No candidate → null (first publish).
 * A `gh` failure throws: degrading to single-version notes would silently drop entries.
 */
async function resolvePublishedFloorTag(targetVersion: string): Promise<string | null> {
	const override = process.env.OMP_RELEASE_NOTES_FLOOR;
	if (override !== undefined) {
		const stripped = override.replace(/^v/, "").trim();
		return stripped.length === 0 ? null : stripped;
	}
	const res = await $`gh release list --repo ${REPO} --limit 200 --json tagName,isDraft,isPrerelease`
		.quiet()
		.nothrow();
	if (res.exitCode !== 0) {
		const stderr = res.stderr.toString().trim();
		throw new Error(
			`gh release list exited ${res.exitCode}.\nstderr: ${stderr || "(empty)"}\n` +
				`Hint: in GitHub Actions, pass GH_TOKEN: \${{ secrets.GITHUB_TOKEN }} to this step. ` +
				`Locally without gh, set OMP_RELEASE_NOTES_FLOOR= to fall back to single-version notes.`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(res.stdout.toString());
	} catch (err) {
		throw new Error(`gh release list returned non-JSON output: ${(err as Error).message}`);
	}
	if (!Array.isArray(raw)) throw new Error(`gh release list returned a non-array payload: ${typeof raw}`);
	return selectPublishedFloorTag(targetVersion, raw as PublishedRelease[]);
}

async function main(): Promise<void> {
	const tagInput = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
	if (!tagInput) {
		console.error("Error: version not provided. Pass as argv (e.g. `v15.4.3`) or set GITHUB_REF_NAME.");
		process.exit(1);
	}
	const version = tagInput.replace(/^v/, "").trim();
	const outputPath = process.argv[3] ?? "release-notes.md";
	if (/^\d+\.\d+\.\d+-canary\.\d+$/.test(version)) {
		const upcomingVersion = version.replace(/-canary\.\d+$/, "");
		await Bun.write(
			outputPath,
			`This is a canary prerelease of ${upcomingVersion}. Install it with \`omp update --canary\`.\n`,
		);
		console.log(`Wrote canary release notes to ${outputPath}.`);
		return;
	}
	const floor = await resolvePublishedFloorTag(version);
	if (floor) {
		console.log(`Aggregating CHANGELOG sections in (${floor}, ${version}].`);
	} else {
		console.log(`No prior published release resolved; emitting only ## [${version}] sections.`);
	}

	const sections: string[] = [];
	const changelogPaths = await Array.fromAsync(changelogGlob.scan("."));
	changelogPaths.sort();
	for (const changelogPath of changelogPaths) {
		const content = await Bun.file(changelogPath).text();
		const merged = mergePackageSection(content, floor, version);
		if (merged === "") continue;
		const pkgDir = changelogPath.replace(/\/CHANGELOG\.md$/, "");
		const name = await loadPackageName(pkgDir);
		sections.push(`## ${name}\n\n${merged}`);
	}

	if (sections.length === 0) {
		console.warn(`No CHANGELOG entries found for version ${version}; writing empty release notes to ${outputPath}.`);
		await Bun.write(outputPath, "");
		process.exit(0);
	}

	const body = `${sections.join("\n\n")}\n`;
	await Bun.write(outputPath, body);
	console.log(
		`Wrote ${sections.length} package section(s) to ${outputPath} (version ${version}${floor ? `, floor ${floor}` : ""}).`,
	);
}

if (import.meta.main) {
	await main();
}
