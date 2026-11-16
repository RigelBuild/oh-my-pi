import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { prompt } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const SUBAGENT_TEMPLATE = path.resolve(import.meta.dir, "../src/prompts/system/subagent-system-prompt.md");

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

// Every agent prompt must carry the evidence-only rule. Subagents run
// with excludeAgentsMd, so their own template is the only place the rule reaches them.
function extractEvidenceBlock(rendered: string): string {
	const match = /<evidence-only>([\s\S]*?)<\/evidence-only>/.exec(rendered);
	expect(match).not.toBeNull();
	return match?.[1] ?? "";
}

function assertCarriesEvidenceRule(rendered: string): void {
	const block = extractEvidenceBlock(rendered);
	// Part 1: ask other agents only for evidence and results.
	expect(block).toContain("evidence and results");
	expect(block).toContain("log lines");
	expect(block).toContain("file paths");
	expect(block).toContain("commands run");
	expect(block).toContain("message IDs");
	expect(block).toContain("final summary");
	// Part 2: never ask for a description of internal process.
	expect(block).toContain("internal process");
	expect(block).toContain("how they did the work");
	// Part 3: never paste a raw transcript or hidden blocks, only the final answer.
	expect(block).toContain("raw transcript");
	expect(block).toContain("hidden blocks");
	expect(block).toContain("final answer");
	// Banned wording: these terms trigger reasoning_extraction refusals.
	expect(block).not.toMatch(/reasoning|thinking process|chain of thought|step by step|explain your/i);
}

describe("evidence-only rule in agent prompts", () => {
	it("subagent system prompt renders the full evidence-only block", async () => {
		const templateSource = await fs.promises.readFile(SUBAGENT_TEMPLATE, "utf-8");
		const rendered = prompt.render(templateSource, { agent: "test-agent" });
		assertCarriesEvidenceRule(rendered);
	});

	describe("main system prompt", () => {
		let tempDir = "";
		let tempHomeDir = "";
		let originalHome: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evidence-only-"));
			tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evidence-only-home-"));
			originalHome = process.env.HOME;
			process.env.HOME = tempHomeDir;
		});

		afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

		it("renders the full evidence-only block", async () => {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: tempDir,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: [],
				workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			});
			assertCarriesEvidenceRule(systemPrompt.join("\n\n"));
		});
	});
});
