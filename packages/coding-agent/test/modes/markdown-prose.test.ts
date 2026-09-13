import { describe, expect, it } from "bun:test";
import { keywordInProse, maskNonProse, stripProseHtmlComments } from "@oh-my-pi/pi-coding-agent/modes/markdown-prose";

const ORCHESTRATE = /\borchestrate\b/i;

describe("maskNonProse", () => {
	it("preserves length and leaves plain prose untouched", () => {
		const text = "please orchestrate the rollout across teams";
		expect(maskNonProse(text)).toBe(text);
	});

	it("returns the input unchanged when no code/markup constructs are present", () => {
		// Fast path: no backtick, angle bracket, or tilde fence.
		const text = "a multi line\nmessage with no markup";
		expect(maskNonProse(text)).toBe(text);
	});

	it("blanks fenced code blocks while keeping indices aligned", () => {
		const text = "before\n```\norchestrate\n```\nafter orchestrate";
		const masked = maskNonProse(text);
		expect(masked.length).toBe(text.length);
		// The fenced occurrence is blanked; the prose occurrence survives at its index.
		expect(masked.indexOf("orchestrate")).toBe(text.lastIndexOf("orchestrate"));
		expect(masked.startsWith("before\n")).toBe(true);
	});

	it("blanks tilde fences and language-tagged fences", () => {
		expect(maskNonProse("~~~\norchestrate\n~~~").includes("orchestrate")).toBe(false);
		expect(maskNonProse("```ts\nconst orchestrate = 1\n```").includes("orchestrate")).toBe(false);
	});

	it("treats an unterminated fence as code through end of text", () => {
		expect(maskNonProse("```\norchestrate").includes("orchestrate")).toBe(false);
	});
});

describe("keywordInProse", () => {
	it("matches a standalone keyword in prose", () => {
		expect(keywordInProse("please orchestrate this", ORCHESTRATE)).toBe(true);
		expect(keywordInProse("orchestrate", ORCHESTRATE)).toBe(true);
	});

	it("ignores keywords inside inline code spans", () => {
		expect(keywordInProse("use `orchestrate` now", ORCHESTRATE)).toBe(false);
		expect(keywordInProse("``a `orchestrate` b``", ORCHESTRATE)).toBe(false);
	});

	it("treats an unmatched backtick run as literal text", () => {
		// A lone backtick opens no span, so the keyword is still prose.
		expect(keywordInProse("the ` then orchestrate", ORCHESTRATE)).toBe(true);
	});

	it("ignores keywords inside fenced code blocks", () => {
		expect(keywordInProse("```\norchestrate\n```", ORCHESTRATE)).toBe(false);
		expect(keywordInProse("text\n```\norchestrate here\n```\ndone", ORCHESTRATE)).toBe(false);
	});

	it("ignores keywords inside XML/HTML sections, including nested and comments", () => {
		expect(keywordInProse("<note>orchestrate</note>", ORCHESTRATE)).toBe(false);
		expect(keywordInProse("<a><a>orchestrate</a></a>", ORCHESTRATE)).toBe(false);
		expect(keywordInProse("<!-- orchestrate -->", ORCHESTRATE)).toBe(false);
		expect(keywordInProse('<tag attr="x>y">orchestrate</tag>', ORCHESTRATE)).toBe(false);
	});

	it("still matches prose outside of code/markup regions", () => {
		expect(keywordInProse("<b>orchestrate</b> then orchestrate", ORCHESTRATE)).toBe(true);
		expect(keywordInProse("run `x` then orchestrate", ORCHESTRATE)).toBe(true);
		expect(keywordInProse("```\ncode\n```\norchestrate", ORCHESTRATE)).toBe(true);
	});

	it("does not over-mask on a stray less-than or an unbalanced tag", () => {
		expect(keywordInProse("a < b and orchestrate", ORCHESTRATE)).toBe(true);
		// <br> has no matching close, so only the tag is masked, not the rest.
		expect(keywordInProse("<br> orchestrate after", ORCHESTRATE)).toBe(true);
	});

	it("respects word boundaries regardless of region", () => {
		expect(keywordInProse("reorchestrate the orchestration", ORCHESTRATE)).toBe(false);
	});
});

describe("stripProseHtmlComments", () => {
	it("removes a comment the terminal renderer would not display", () => {
		expect(stripProseHtmlComments("before <!-- hidden --> after")).toBe("before  after");
	});

	it("returns the input unchanged when it holds no comment", () => {
		const text = "plain prose with <br> and `code`";
		expect(stripProseHtmlComments(text)).toBe(text);
	});

	it("keeps a comment a fenced block displays deliberately", () => {
		const text = "```html\n<!-- kept -->\n```";
		expect(stripProseHtmlComments(text)).toBe(text);
	});

	it("keeps a comment quoted in an inline code span", () => {
		const text = "the token is `<!-- HALT: done -->` exactly";
		expect(stripProseHtmlComments(text)).toBe(text);
	});

	it("strips a prose comment while keeping a fenced one in the same message", () => {
		const text = "intro <!-- gone -->\n\n```html\n<!-- kept -->\n```\n\ntail";
		expect(stripProseHtmlComments(text)).toBe("intro \n\n```html\n<!-- kept -->\n```\n\ntail");
	});

	it("drops an unterminated comment through the end of the text", () => {
		// The renderer's own comment regex is equally unbounded, so a half-written
		// comment must not print the rest of the message as markup.
		expect(stripProseHtmlComments("visible <!-- never closed")).toBe("visible ");
	});

	it("removes every prose comment, not just the first", () => {
		expect(stripProseHtmlComments("a <!-- one --> b <!-- two --> c")).toBe("a  b  c");
	});
});
