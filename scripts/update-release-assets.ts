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

function run(command: readonly string[]): string {
	const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command[0]} exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr).trim()}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

async function main(): Promise<void> {
	const [tag, ...extra] = process.argv.slice(2);
	if (!tag || extra.length > 0 || !/^v?[0-9][A-Za-z0-9.+-]*$/.test(tag)) {
		throw new Error("usage: update-release-assets.ts <release-tag>");
	}
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
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
		const hashes = new Map<string, string>();
		for (const line of checksumsText.split(/\r?\n/)) {
			if (!line) continue;
			const entry = /^(?<hash>[a-fA-F0-9]{64})\s+\*?(?<name>.+)$/.exec(line);
			if (!entry?.groups) throw new Error(`invalid SHA256SUMS.txt line: ${line}`);
			hashes.set(entry.groups.name, entry.groups.hash.toLowerCase());
		}

		const entries = Object.entries(ASSETS).map(([system, name]) => {
			const hex = hashes.get(name);
			if (!hex) throw new Error(`SHA256SUMS.txt has no checksum for ${name}`);
			const sri = run(["nix", "hash", "convert", "--hash-algo", "sha256", "--to", "sri", hex]);
			return { system, name, sri };
		});

		const output = [
			"{",
			`  version = ${JSON.stringify(version)};`,
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
		await Bun.write("nix/release-assets.nix", output);
		console.log(`Updated nix/release-assets.nix for ${tag}`);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

if (import.meta.main) await main();
