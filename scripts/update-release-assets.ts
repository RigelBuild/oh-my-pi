#!/usr/bin/env bun
/**
 * Refresh nix/release-assets.nix from a GitHub release's SHA256SUMS.txt.
 *
 * Usage: bun scripts/update-release-assets.ts <release-tag>
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ASSETS = {
	"x86_64-linux": "omp-linux-x64",
	"aarch64-linux": "omp-linux-arm64",
	"aarch64-darwin": "omp-darwin-arm64",
	"x86_64-darwin": "omp-darwin-x64",
} satisfies Record<string, string>;

export function parseSha256Sums(text: string): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const entry = /^(?<hash>[a-fA-F0-9]{64})\s+\*?(?<name>.+)$/.exec(line);
		if (!entry?.groups) throw new Error(`invalid SHA256SUMS.txt line: ${line}`);
		hashes[entry.groups.name] = entry.groups.hash.toLowerCase();
	}
	return hashes;
}

function sha256ToSri(hex: string): string {
	if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`invalid SHA-256 checksum: ${hex}`);
	const bytes = Uint8Array.from({ length: 32 }, (_, index) =>
		Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
	);
	return `sha256-${btoa(String.fromCharCode(...bytes))}`;
}

export function renderReleaseAssets(version: string, hashes: Readonly<Record<string, string>>): string {
	const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
	const entries = Object.entries(ASSETS).map(([system, name]) => {
		const hex = hashes[name];
		if (!hex) throw new Error(`SHA256SUMS.txt has no checksum for ${name}`);
		return { system, name, sri: sha256ToSri(hex) };
	});

	return [
		"{",
		`  version = ${JSON.stringify(normalizedVersion)};`,
		"  assets = {",
		...entries.flatMap(({ system, name, sri }) => [
			`    ${system} = {`,
			`      name = ${JSON.stringify(name)};`,
			`      hash = ${JSON.stringify(sri)};`,
			"    };",
		]),
		"  };",
		"}",
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const [inputTag, ...extra] = process.argv.slice(2);
	if (!inputTag || extra.length > 0 || !/^v?[0-9][A-Za-z0-9.+-]*$/.test(inputTag)) {
		throw new Error("usage: update-release-assets.ts <release-tag>");
	}
	const tag = inputTag.startsWith("v") ? inputTag : `v${inputTag}`;
	const version = tag.slice(1);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-assets-"));
	try {
		const download = Bun.spawn(
			[
				"gh",
				"release",
				"download",
				tag,
				"--repo",
				"RigelBuild/oh-my-pi",
				"--pattern",
				"SHA256SUMS.txt",
				"--dir",
				tempDir,
			],
			{ stdout: "inherit", stderr: "inherit" },
		);
		const downloadExit = await download.exited;
		if (downloadExit !== 0) throw new Error(`gh release download exited ${downloadExit}`);

		const checksumsText = await Bun.file(path.join(tempDir, "SHA256SUMS.txt")).text();
		const output = renderReleaseAssets(version, parseSha256Sums(checksumsText));
		await Bun.write(path.join(import.meta.dir, "..", "nix", "release-assets.nix"), output);
		console.log(`Updated nix/release-assets.nix for ${tag}`);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

if (import.meta.main) await main();
