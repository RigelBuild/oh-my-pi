#!/usr/bin/env bun
/**
 * Fork-only npm scope rename applied at publish time.
 *
 * Workspace manifests and source retain upstream names. Only packed tarballs
 * are rewritten after Bun resolves workspace protocols and runs prepack.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

export const RIGEL_SCOPE = "@rigelbuild";
export const UPSTREAM_SCOPE = "@oh-my-pi";
const SCOPED_NAME = /@oh-my-pi\/([a-zA-Z0-9._-]+)/g;
const MODULE_SPECIFIER =
	/((?:\bfrom|\bimport|\bexport|\brequire\s*\(|\bimport\s*\(|\bdeclare\s+module)\s*)(["'])@oh-my-pi\/([a-zA-Z0-9._-]+)/g;
const CODE_EXTENSIONS: Record<string, true> = {
	".ts": true,
	".tsx": true,
	".mts": true,
	".cts": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
};

/** Rename a package segment to its published Rigel name. */
export function renameSegment(segment: string): string {
	let base = segment;
	if (base.startsWith("pi-")) base = base.slice("pi-".length);
	else if (base.startsWith("omp-")) base = base.slice("omp-".length);
	return `${RIGEL_SCOPE}/omp-${base}`;
}

/** Rename a full `@oh-my-pi/<name>` identifier without changing other scopes. */
export function renamePackageName(name: string): string {
	const at = name.indexOf("/");
	if (at < 0 || !name.startsWith(`${UPSTREAM_SCOPE}/`)) return name;
	return renameSegment(name.slice(at + 1));
}

/** Rewrite every `@oh-my-pi/*` occurrence in a manifest, preserving subpaths. */
export function rewriteText(text: string): string {
	return text.replace(SCOPED_NAME, (_match, segment: string) => renameSegment(segment));
}

/** Rewrite module specifiers but leave unrelated strings and prose intact. */
export function rewriteModuleSpecifiers(text: string): string {
	return text.replace(MODULE_SPECIFIER, (_match, pre: string, quote: string, segment: string) => {
		return `${pre}${quote}${renameSegment(segment)}`;
	});
}

/** Rewrite an npm archive in place without changing working-tree files. */
export async function renameTarballScope(tarballPath: string): Promise<void> {
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rename-"));
	try {
		await $`tar -xzf ${tarballPath} -C ${workDir}`.quiet();
		const pkgRoot = path.join(workDir, "package");
		const entries = await fs.readdir(pkgRoot, { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const file = path.join(entry.parentPath, entry.name);
			const isManifest = entry.name === "package.json";
			if (!isManifest && !CODE_EXTENSIONS[path.extname(entry.name)]) continue;
			const buf = await fs.readFile(file);
			if (buf.includes(0)) continue;
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
			} catch {
				continue;
			}
			if (!text.includes(`${UPSTREAM_SCOPE}/`)) continue;
			const rewritten = isManifest ? rewriteText(text) : rewriteModuleSpecifiers(text);
			if (rewritten !== text) await fs.writeFile(file, rewritten);
		}
		await $`tar -czf ${tarballPath} -C ${workDir} package`.quiet();
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}

/**
 * Fail if two upstream names collapse to the same Rigel package name. The
 * prefix-stripping rule is not injective, so validate the whole publish set.
 */
export function assertNoRenameCollisions(names: readonly string[]): void {
	const byTarget = new Map<string, string>();
	for (const name of names) {
		const renamed = renamePackageName(name);
		if (renamed === name) continue;
		const prior = byTarget.get(renamed);
		if (prior && prior !== name) {
			throw new Error(`Rename collision: '${prior}' and '${name}' both map to '${renamed}'`);
		}
		byTarget.set(renamed, name);
	}
}
