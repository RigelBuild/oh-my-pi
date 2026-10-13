#!/usr/bin/env bun
// Validates `.github/rigel-version` changes and mints its `vX.Y.Z-rigel.N` tag.
// Usage: release-tag.ts check-pr <base-sha> <head-sha> | mint <sha> <owner/repo>
import { $ } from "bun";

const VERSION_FILE = ".github/rigel-version";
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rigel\.([1-9]\d*)$/;

export interface TrackingVersion {
	base: string;
	n: bigint;
}

export function parseTrackingVersion(version: string): TrackingVersion | null {
	const m = VERSION_RE.exec(version);
	return m ? { base: `${m[1]}.${m[2]}.${m[3]}`, n: BigInt(m[4]) } : null;
}

export function expectedNextVersion(base: string, tags: readonly string[]): string {
	let max = 0n;
	for (const tag of tags) {
		const v = tag.startsWith("v") ? parseTrackingVersion(tag.slice(1)) : null;
		if (v && v.base === base && v.n > max) max = v.n;
	}
	return `${base}-rigel.${max + 1n}`;
}

async function versionAt(cwd: string, sha: string): Promise<string | null> {
	const commit = await $`git rev-parse --verify --quiet ${`${sha}^{commit}`}`.cwd(cwd).quiet().nothrow();
	if (commit.exitCode !== 0) throw new Error(`${sha} is not a commit`);
	const out = await $`git show ${`${sha}:${VERSION_FILE}`}`.cwd(cwd).quiet().nothrow();
	if (out.exitCode !== 0) return null;
	const lines = out
		.text()
		.split("\n")
		.filter(line => line !== "");
	if (lines.length !== 1)
		throw new Error(`expected exactly one ${VERSION_FILE} line at ${sha}, found ${lines.length}`);
	return lines[0];
}

async function validateNext(cwd: string, version: string): Promise<void> {
	const parsed = parseTrackingVersion(version);
	if (!parsed) throw new Error(`version '${version}' does not match the required X.Y.Z-rigel.N shape`);
	const tags = (await $`git tag --list ${`v${parsed.base}-rigel.*`}`.cwd(cwd).quiet().text()).split("\n");
	const expected = expectedNextVersion(parsed.base, tags);
	if (version !== expected) throw new Error(`expected ${expected}, got ${version}`);
}

/** Returns "unchanged" or the validated new version. */
export async function checkPr(cwd: string, baseSha: string, headSha: string): Promise<string> {
	const headVersion = await versionAt(cwd, headSha);
	if (headVersion === (await versionAt(cwd, baseSha))) return "unchanged";
	if (headVersion === null) throw new Error(`${VERSION_FILE} was removed`);
	await validateNext(cwd, headVersion);
	return headVersion;
}

/** The tag to create and its commit, or null when there is nothing to mint. */
export async function mintTarget(cwd: string, sha: string): Promise<{ tag: string; sha: string } | null> {
	const version = await versionAt(cwd, sha);
	if (version === null) return null;
	const tag = `v${version}`;
	if ((await $`git show-ref --verify --quiet ${`refs/tags/${tag}`}`.cwd(cwd).nothrow()).exitCode === 0) return null;
	// Tag the commit that introduced the version, so a later push doesn't move the release.
	let target = sha;
	for (;;) {
		const parent = await $`git rev-parse --verify --quiet ${`${target}^1`}`.cwd(cwd).quiet().nothrow();
		if (parent.exitCode !== 0) break;
		const parentSha = parent.text().trim();
		if ((await versionAt(cwd, parentSha)) !== version) break;
		target = parentSha;
	}
	await validateNext(cwd, version);
	return { tag, sha: target };
}

async function mint(sha: string, repo: string): Promise<void> {
	const target = await mintTarget(process.cwd(), sha);
	if (!target) {
		console.log("No release tag to mint");
		return;
	}
	const remote = await $`gh api ${`repos/${repo}/git/ref/tags/${target.tag}`} --jq .object.sha`.quiet().nothrow();
	if (remote.exitCode === 0) {
		const actual = remote.text().trim();
		if (actual !== target.sha) throw new Error(`${target.tag} already exists at ${actual}, expected ${target.sha}`);
		console.log(`${target.tag} already points at ${target.sha}`);
		return;
	}
	await $`gh api --method POST ${`repos/${repo}/git/refs`} -f ${`ref=refs/tags/${target.tag}`} -f ${`sha=${target.sha}`}`.quiet();
	console.log(`Created ${target.tag} at ${target.sha}`);
}

if (import.meta.main) {
	const [command, a, b] = process.argv.slice(2);
	try {
		if (command === "check-pr" && a && b) {
			const result = await checkPr(process.cwd(), a, b);
			console.log(result === "unchanged" ? `${VERSION_FILE} is unchanged` : `${result} is the next release version`);
		} else if (command === "mint" && a && b) {
			await mint(a, b);
		} else {
			console.error("Usage: release-tag.ts check-pr <base-sha> <head-sha> | mint <sha> <owner/repo>");
			process.exit(2);
		}
	} catch (error) {
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
