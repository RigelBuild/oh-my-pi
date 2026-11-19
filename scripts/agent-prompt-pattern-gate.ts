#!/usr/bin/env bun
// Fails when an agent prompt asks the model to show its reasoning (RIG-10290).
//
// Scans the globs in scripts/agent-prompt-pattern-gate.config.json (rendered
// from the .cue source beside it). A line matches when the banned pattern hits
// it after every config-key match is blanked, so `reasoning_effort: high` and
// `disableReasoning: true` pass while prose such as "show your work" fails.
//
// Exit codes: 0 clean, 1 at least one finding, 2 config or read error.
import * as path from "node:path";
import { Glob } from "bun";

export interface GateConfig {
	globs: string[];
	excludeGlobs: string[];
	pattern: string;
	configKeys: string[];
	exceptions: string[];
}

export interface Finding {
	path: string;
	line: number;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "scripts/agent-prompt-pattern-gate.config.json");

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function parseConfig(value: unknown): GateConfig {
	if (typeof value !== "object" || value === null) {
		throw new Error("config must be an object");
	}
	if (!("globs" in value) || !isStringArray(value.globs) || value.globs.length === 0) {
		throw new Error("config.globs must be a non-empty string array");
	}
	if (!("excludeGlobs" in value) || !isStringArray(value.excludeGlobs)) {
		throw new Error("config.excludeGlobs must be a string array");
	}
	if (!("pattern" in value) || typeof value.pattern !== "string" || value.pattern === "") {
		throw new Error("config.pattern must be a non-empty string");
	}
	if (!("configKeys" in value) || !isStringArray(value.configKeys)) {
		throw new Error("config.configKeys must be a string array");
	}
	if (!("exceptions" in value) || !isStringArray(value.exceptions)) {
		throw new Error("config.exceptions must be a string array");
	}
	return {
		globs: value.globs,
		excludeGlobs: value.excludeGlobs,
		pattern: value.pattern,
		configKeys: value.configKeys,
		exceptions: value.exceptions,
	};
}

// The config is written in Go RE2 syntax, which allows a leading `(?i)`.
// JavaScript has no inline flags, so that prefix becomes the `i` flag.
// Any other inline flag fails to compile, which fails the gate closed.
export function compileRegExp(source: string, flags = ""): RegExp {
	const inline = /^\(\?i\)/.exec(source);
	const body = inline ? source.slice(inline[0].length) : source;
	return new RegExp(body, inline ? `${flags}i` : flags);
}

export function blankConfigKeys(line: string, keys: RegExp[]): string {
	let text = line;
	for (const key of keys) {
		text = text.replace(key, match => " ".repeat(match.length));
	}
	return text;
}

export function findViolations(
	filePath: string,
	text: string,
	pattern: RegExp,
	keys: RegExp[],
	exceptions: ReadonlySet<string>,
): Finding[] {
	const findings: Finding[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = index + 1;
		if (exceptions.has(`${filePath}:${line}`)) continue;
		if (pattern.test(blankConfigKeys(lines[index], keys))) {
			findings.push({ path: filePath, line });
		}
	}
	return findings;
}

export async function listScopedFiles(root: string, cfg: GateConfig): Promise<string[]> {
	const excluded = cfg.excludeGlobs.map(glob => new Glob(glob));
	const files = new Set<string>();
	for (const glob of cfg.globs) {
		for await (const rel of new Glob(glob).scan({ cwd: root, onlyFiles: true, dot: true })) {
			if (!excluded.some(ex => ex.match(rel))) {
				files.add(rel);
			}
		}
	}
	return [...files].sort();
}

export async function run(root: string, cfg: GateConfig, stderr: (line: string) => void): Promise<number> {
	const pattern = compileRegExp(cfg.pattern);
	const keys = cfg.configKeys.map(key => compileRegExp(key, "g"));
	const exceptions = new Set(cfg.exceptions);
	let found = false;
	for (const rel of await listScopedFiles(root, cfg)) {
		const text = await Bun.file(path.join(root, rel)).text();
		for (const finding of findViolations(rel, text, pattern, keys, exceptions)) {
			stderr(`${finding.path}:${finding.line}: disallowed prompt pattern\n`);
			found = true;
		}
	}
	return found ? 1 : 0;
}

if (import.meta.main) {
	try {
		const cfg = parseConfig(await Bun.file(CONFIG_PATH).json());
		process.exit(await run(REPO_ROOT, cfg, line => process.stderr.write(line)));
	} catch (error) {
		process.stderr.write(`agent-prompt-pattern-gate: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
}
