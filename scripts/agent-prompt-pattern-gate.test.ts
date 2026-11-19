import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	type GateConfig,
	blankConfigKeys,
	compileRegExp,
	findViolations,
	parseConfig,
	run,
} from "./agent-prompt-pattern-gate";

const CONFIG_PATH = path.join(import.meta.dir, "agent-prompt-pattern-gate.config.json");

async function loadRealConfig(): Promise<GateConfig> {
	return parseConfig(await Bun.file(CONFIG_PATH).json());
}

function compiled(cfg: GateConfig) {
	return {
		pattern: compileRegExp(cfg.pattern),
		keys: cfg.configKeys.map(key => compileRegExp(key, "g")),
	};
}

describe("findViolations positive control", () => {
	test("a banned prose fixture fails with its line number", async () => {
		const cfg = await loadRealConfig();
		const { pattern, keys } = compiled(cfg);
		const text = "# Index\n\nWalk me through your reasoning before editing.\n";
		const findings = findViolations("AGENTS.md", text, pattern, keys, new Set());
		expect(findings).toEqual([{ path: "AGENTS.md", line: 3 }]);
	});

	test("the banned pattern is case-insensitive", async () => {
		const cfg = await loadRealConfig();
		const { pattern, keys } = compiled(cfg);
		const findings = findViolations("p.md", "Please THINK ALOUD\n", pattern, keys, new Set());
		expect(findings).toEqual([{ path: "p.md", line: 1 }]);
	});

	test("a banned phrase on a line with an allowlisted key still fails", async () => {
		const cfg = await loadRealConfig();
		const { pattern, keys } = compiled(cfg);
		const findings = findViolations("p.md", "reasoning_effort: high; show your work\n", pattern, keys, new Set());
		expect(findings).toEqual([{ path: "p.md", line: 1 }]);
	});
});

describe("findViolations allowlist", () => {
	test("an allowlisted config key passes", async () => {
		const cfg = await loadRealConfig();
		const { pattern, keys } = compiled(cfg);
		for (const line of [
			"reasoning_effort: high",
			"  thinkingLevel: medium",
			'"disableReasoning": true,',
			"disableReasoning: true,",
			"  --reasoning high",
		]) {
			expect(findViolations("p.md", `${line}\n`, pattern, keys, new Set())).toEqual([]);
		}
	});

	test("blankConfigKeys keeps the rest of the line intact", async () => {
		const cfg = await loadRealConfig();
		const keys = cfg.configKeys.map(key => compileRegExp(key, "g"));
		expect(blankConfigKeys("disableReasoning: true", keys).trim()).toBe("true");
	});

	test("a reviewed path:line exception is suppressed", async () => {
		const cfg = await loadRealConfig();
		const { pattern, keys } = compiled(cfg);
		const findings = findViolations("p.md", "Show your work.\n", pattern, keys, new Set(["p.md:1"]));
		expect(findings).toEqual([]);
	});
});

describe("run end to end", () => {
	async function fixtureRoot(files: Record<string, string>): Promise<string> {
		const root = await fs.mkdtemp(path.join(tmpdir(), "agent-prompt-gate-"));
		for (const [rel, body] of Object.entries(files)) {
			const full = path.join(root, rel);
			await fs.mkdir(path.dirname(full), { recursive: true });
			await Bun.write(full, body);
		}
		return root;
	}

	function cfgFor(globs: string[]): GateConfig {
		return {
			globs,
			excludeGlobs: ["packages/catalog/src/compat/rules/**"],
			pattern: "(?i)show your work",
			configKeys: [],
			exceptions: [],
		};
	}

	test("a banned AGENTS.md fixture exits 1 and reports the location", async () => {
		const root = await fixtureRoot({ "AGENTS.md": "# Index\n\nShow your work before editing.\n" });
		const lines: string[] = [];
		const code = await run(root, cfgFor(["AGENTS.md"]), line => lines.push(line));
		expect(code).toBe(1);
		expect(lines.join("")).toContain("AGENTS.md:3: disallowed prompt pattern");
	});

	test("an allowlisted key fixture exits 0", async () => {
		const root = await fixtureRoot({ "AGENTS.md": "reasoning_effort: high\ndisableReasoning: true\n" });
		const lines: string[] = [];
		const code = await run(root, cfgFor(["AGENTS.md"]), line => lines.push(line));
		expect(code).toBe(0);
		expect(lines).toEqual([]);
	});

	test("a catalog compat rule with banned text is excluded from the scan", async () => {
		const root = await fixtureRoot({
			"packages/catalog/src/compat/rules/x.kdl": "Show your work.\n",
		});
		const lines: string[] = [];
		const code = await run(root, cfgFor(["packages/catalog/src/compat/rules/**"]), line => lines.push(line));
		expect(code).toBe(0);
		expect(lines).toEqual([]);
	});
});

describe("parseConfig", () => {
	test("rejects a config with no globs", () => {
		expect(() => parseConfig({ globs: [], excludeGlobs: [], pattern: "x", configKeys: [], exceptions: [] })).toThrow(
			"config.globs",
		);
	});

	test("rejects an empty pattern", () => {
		expect(() =>
			parseConfig({ globs: ["a"], excludeGlobs: [], pattern: "", configKeys: [], exceptions: [] }),
		).toThrow("config.pattern");
	});
});
