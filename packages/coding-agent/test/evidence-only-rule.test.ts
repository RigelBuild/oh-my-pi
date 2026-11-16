import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

// Every selected template gets the shared evidence-only block once, from the
// builder. A literal customPrompt or SDK string systemPrompt is the only opt-out.
describe("evidence-only rule in every system prompt", () => {
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

	function build(options: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}): Promise<string[]> {
		return buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...options,
		}).then(result => result.systemPrompt);
	}

	// Presence and the ban list only. Banned wording triggers reasoning_extraction refusals.
	function expectOneRuleBlock(blocks: string[]): void {
		const carriers = blocks.filter(block => /<evidence-only>[\s\S]*<\/evidence-only>/.test(block));
		expect(carriers).toHaveLength(1);
		expect(carriers[0]).not.toMatch(/reasoning|thinking process|chain of thought|step by step|explain your/i);
	}

	it("the default main prompt carries the rule once", async () => {
		expectOneRuleBlock(await build());
	});

	it("a literal customPrompt still carries the rule", async () => {
		expectOneRuleBlock(await build({ customPrompt: "You are a custom assistant." }));
	});

	it("a systemPromptTemplate still carries the rule", async () => {
		expectOneRuleBlock(await build({ systemPromptTemplate: "Custom template body.\n{{#if subagent}}sub{{/if}}" }));
	});

	it("a subagent prompt carries the rule once", async () => {
		expectOneRuleBlock(await build({ subagent: true, personality: "none" }));
	});
});
