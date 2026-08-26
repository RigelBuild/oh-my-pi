#!/usr/bin/env bun
/**
 * Fork-only npm scope rename applied at publish time.
 *
 * Upstream ships every workspace package under the `@oh-my-pi/*` scope. This
 * fork republishes the same closure under `@rigelbuild/omp-*` for Rigel-org
 * consumers (compass) without diverging the on-repo source: the working-tree
 * manifests and `src/` keep the `@oh-my-pi/*` names so local dev, `bun link`,
 * source installs, and future upstream merges stay clean. The rename happens on
 * the *packed tarball* only — after `bun pm pack` has resolved the
 * `catalog:`/`workspace:` protocols and run each package's `prepack` (both of
 * which need the `@oh-my-pi/*` names intact) — so nothing on disk changes.
 *
 * The mapping is a single deterministic rule (Matt, RIG-2511): take the segment
 * after the scope, strip a leading `pi-` or `omp-`, and re-prefix
 * `@rigelbuild/omp-`. It applies uniformly to package names, cross-package
 * dependency keys, native leaf packages (`@oh-my-pi/pi-natives-<tag>`), and
 * import specifiers inside the shipped source — including subpath imports, whose
 * trailing `/...` is preserved.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

/** npm scope the fork publishes under. */
export const RIGEL_SCOPE = "@rigelbuild";
/** Scope the upstream workspace packages use on-repo. */
export const UPSTREAM_SCOPE = "@oh-my-pi";

/** First path segment of a scoped name may contain these characters. */
const SCOPED_NAME = /@oh-my-pi\/([a-zA-Z0-9._-]+)/g;

/**
 * Rename one `@oh-my-pi/*` package-name segment to its `@rigelbuild/omp-*`
 * form. `segment` is the part after the scope and before any subpath (e.g.
 * `pi-utils`, `omptype`, `pi-natives-linux-x64`).
 */
export function renameSegment(segment: string): string {
	let base = segment;
	if (base.startsWith("pi-")) base = base.slice("pi-".length);
	else if (base.startsWith("omp-")) base = base.slice("omp-".length);
	return `${RIGEL_SCOPE}/omp-${base}`;
}

/** Rename a full `@oh-my-pi/<name>` package identifier (no subpath). */
export function renamePackageName(name: string): string {
	const at = name.indexOf("/");
	if (at < 0 || !name.startsWith(`${UPSTREAM_SCOPE}/`)) return name;
	return renameSegment(name.slice(at + 1));
}

/**
 * Rewrite every `@oh-my-pi/<seg>` occurrence in arbitrary text to its renamed
 * form. Used for `package.json`, where every occurrence is a package name or a
 * dependency key. The captured segment stops at the first `/`, so a subpath like
 * `@oh-my-pi/omptype/ark` keeps its `/ark` tail.
 */
export function rewriteText(text: string): string {
	return text.replace(SCOPED_NAME, (_match, segment: string) => renameSegment(segment));
}

/**
 * Import/export/require specifier contexts. Matches the upstream scope only when
 * it is the target of an `import`/`export … from`, a bare `import "…"`, a
 * `require("…")`, a dynamic `import("…")`, or a `declare module "…"` type
 * augmentation — so string literals that merely contain `@oh-my-pi` (CLI help
 * text, the `CANONICAL_PI_SCOPE = "@oh-my-pi"` plugin-compat constant, changelog
 * prose) are left untouched. A stale `declare module` target would silently
 * detach the augmentation from the renamed package for a typed consumer, so it
 * must track the rename like any other specifier. Group 1 is the pre-specifier
 * context (kept verbatim), group 2 the quote, group 3 the segment.
 */
const MODULE_SPECIFIER =
	/((?:\bfrom|\bimport|\bexport|\brequire\s*\(|\bimport\s*\(|\bdeclare\s+module)\s*)(["'])@oh-my-pi\/([a-zA-Z0-9._-]+)/g;

/**
 * Rewrite only module-specifier occurrences of the upstream scope in code text,
 * preserving any following subpath and leaving unrelated string literals alone.
 */
export function rewriteModuleSpecifiers(text: string): string {
	return text.replace(MODULE_SPECIFIER, (_m, pre: string, quote: string, segment: string) => {
		return `${pre}${quote}${renameSegment(segment)}`;
	});
}

/** File extensions whose `@oh-my-pi` occurrences are code, not free text. */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Rewrite an already-packed `.tgz` in place so it publishes under the
 * `@rigelbuild/omp-*` scope. Extracts the archive and rewrites two member
 * classes:
 *   - `package.json` — every `@oh-my-pi/*` occurrence (name + dependency keys).
 *   - code files (`.ts`/`.js`/…) — module specifiers only, so real imports of
 *     cross-package deps (including the externalized `@oh-my-pi/pi-natives`
 *     import baked into the published bundle) track the renamed manifest deps,
 *     while string literals such as the plugin-compat scope constant and CLI
 *     help text keep their historical `@oh-my-pi` spelling.
 * Everything else (READMEs, CHANGELOGs, generated assets) is left as written.
 * Binary members (native `.node` addons) are detected by a NUL byte and never
 * touched, so their bytes never shift. Repacks with the same single `package/`
 * layout npm expects; `inspectPackedTarball` then reads the renamed identity.
 */
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
			const isCode = CODE_EXTENSIONS.has(path.extname(entry.name));
			if (!isManifest && !isCode) continue;
			const buf = await fs.readFile(file);
			if (buf.includes(0)) continue; // binary member — never rewrite
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
			} catch {
				continue; // not valid UTF-8 — treat as binary
			}
			if (!text.includes(`${UPSTREAM_SCOPE}/`)) continue;
			const rewritten = isManifest ? rewriteText(text) : rewriteModuleSpecifiers(text);
			if (rewritten !== text) await fs.writeFile(file, rewritten);
		}
		// Repack with the same `package/`-prefixed layout npm reads.
		await $`tar -czf ${tarballPath} -C ${workDir} package`.quiet();
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}

/**
 * Fail loudly if two distinct upstream names collapse to one renamed target.
 * The strip-then-prefix rule is not injective (`pi-stats` and `omp-stats` both
 * map to `@rigelbuild/omp-stats`), so a future upstream package differing only
 * by the `pi-`/`omp-` prefix would silently publish over its sibling. The live
 * closure has no collision; this guard keeps it that way. Call it once over the
 * full publish set before packing.
 */
export function assertNoRenameCollisions(names: readonly string[]): void {
	const byTarget = new Map<string, string>();
	for (const name of names) {
		const renamed = renamePackageName(name);
		if (renamed === name) continue; // not an upstream-scoped name
		const prior = byTarget.get(renamed);
		if (prior && prior !== name) {
			throw new Error(`Rename collision: '${prior}' and '${name}' both map to '${renamed}'`);
		}
		byTarget.set(renamed, name);
	}
}
