import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	sanitizeSkillName,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import manageSkillDescription from "../prompts/tools/manage-skill.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgAutolearnEnabled, cfgAutolearnJournalDir } from "../autolearn/settings";

const manageSkillSchema = type({
	action: "'create' | 'update' | 'delete'",
	name: type("string").describe("kebab-case skill name"),
	"description?": type("string").describe(
		"one-line description of when to use the skill (required for create/update)",
	),
	"body?": type("string").describe("the SKILL.md body in markdown, no frontmatter (required for create/update)"),
}).narrow(
	(p, ctx) =>
		p.action === "delete" ||
		(p.description !== undefined && p.body !== undefined) ||
		// Enforce the action/field contract at validation time rather than only in
		// execute. Kept as a cross-field narrow (not a discriminated union) so the
		// wire schema stays a single root object — strict structured-output mode and
		// the Anthropic tool-schema builder both require that.
		ctx.mustBe('used with both "description" and "body" for "create" and "update"'),
);

export type ManageSkillParams = typeof manageSkillSchema.infer;

/**
 * Direct create/update/delete of isolated managed skills. Gated behind
 * `autolearn.enabled`; backend-independent (the skill side is standalone).
 */
export class ManageSkillTool implements AgentTool<typeof manageSkillSchema> {
	readonly name = "manage_skill";
	readonly approval = "write" as const;
	readonly label = "Manage Skill";
	readonly description = manageSkillDescription;
	readonly parameters = manageSkillSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Create, update, or delete an isolated managed skill";

	constructor(
		private readonly refreshSkills?: () => Promise<void>,
		private readonly journal?: ManageSkillJournal,
	) {}

	/**
	 * Main-turn registration. Journal mode registers nothing here: the tool exists only on the
	 * capture turn (built by the capture wiring), so the main turn has no tool and no guidance.
	 */
	static createIf(session: ToolSession): ManageSkillTool | null {
		if (!cfgAutolearnEnabled.get(session.settings)) return null;
		if (cfgAutolearnJournalDir.get(session.settings)) return null;
		return new ManageSkillTool(session.refreshSkills);
	}

	async execute(id: string, params: ManageSkillParams): Promise<AgentToolResult> {
		if (this.journal) return writeJournalLesson(this.journal, id, params);
		if (params.action === "delete") {
			await deleteManagedSkill(params.name);
			await this.refreshSkills?.();
			return {
				content: [{ type: "text", text: `Deleted managed skill "${params.name}".` }],
				details: { action: "delete", name: params.name },
			};
		}

		// Defensive narrowing: the schema refine already rejects create/update
		// without both fields, so this is unreachable for valid input — it only
		// proves the strings are present to `writeManagedSkill`'s typed contract.
		if (!params.description || !params.body) {
			throw new Error(`"${params.action}" requires both "description" and "body".`);
		}
		// A managed skill resolves below any authored skill of the same name
		// (authored always wins in discovery), so creating one under a name an
		// authored skill already claims writes a file that never surfaces. Refuse
		// up front rather than report a false "Created". `sanitizeSkillName`
		// normalizes to the on-disk name the discovery scan compares against.
		if (params.action === "create" && isNameClaimedByAuthoredSkill(sanitizeSkillName(params.name))) {
			return {
				content: [
					{
						type: "text",
						text: `Cannot create managed skill "${params.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
					},
				],
				isError: true,
				details: { action: "create", name: params.name, shadowed: true },
			};
		}
		const { path: skillPath } = await writeManagedSkill({
			action: params.action,
			name: params.name,
			description: params.description,
			body: params.body,
		});
		await this.refreshSkills?.();
		const relativePath = path.relative(getManagedSkillsDir(), skillPath);
		const verb = params.action === "create" ? "Created" : "Updated";
		return {
			content: [{ type: "text", text: `${verb} managed skill "${params.name}" (managed-skills/${relativePath}).` }],
			details: { action: params.action, name: params.name },
		};
	}
}

/** Journal-only mode: every call becomes one lesson file; managed skills are never touched. */
export interface ManageSkillJournal {
	journalDir: string;
	secretPatterns: readonly RegExp[];
	sessionId: string;
	cwd: string;
	/** Injection point between the temp write and the publishing link(); tests only. */
	beforePublish?: (tempPath: string) => Promise<void>;
}

/** Compile `autolearn.secretPatterns` entries; an invalid expression matches literally. */
export function compileSecretPatterns(patterns: readonly string[]): RegExp[] {
	return patterns.map(pattern => {
		try {
			return new RegExp(pattern);
		} catch {
			return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		}
	});
}

/** Front matter value as a JSON string: YAML reads it as a quoted scalar, newlines stay escaped. */
function frontMatterValue(value: string | boolean): string {
	return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

function journalError(text: string, details: Record<string, unknown>): AgentToolResult {
	return { content: [{ type: "text", text }], isError: true, details };
}

async function writeJournalLesson(
	journal: ManageSkillJournal,
	toolCallId: string,
	params: ManageSkillParams,
): Promise<AgentToolResult> {
	const body = params.body ?? "";
	// Secret check before any write: on a match, not even a temp file exists. Name the pattern, never the value.
	const checked = `${params.name}\n${params.description ?? ""}\n${body}`;
	const hit = journal.secretPatterns.find(pattern => pattern.test(checked));
	if (hit) {
		return journalError(
			`Refused lesson: it matches secret pattern /${hit.source}/. Remove the credential and retry.`,
			{
				action: params.action,
				secretPattern: hit.source,
			},
		);
	}
	const authored = params.action === "create" && isNameClaimedByAuthoredSkill(sanitizeSkillName(params.name));
	const frontMatter = [
		"---",
		`session: ${frontMatterValue(journal.sessionId)}`,
		`tool_call: ${frontMatterValue(toolCallId)}`,
		`cwd: ${frontMatterValue(journal.cwd)}`,
		`action: ${params.action}`,
		`name: ${frontMatterValue(params.name)}`,
		`authored: ${frontMatterValue(authored)}`,
		`description: ${frontMatterValue(params.description ?? "")}`,
		"---",
		"",
	].join("\n");
	// Compact UTC stamp YYYYMMDDTHHMMSSZ.
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	const fileId = `${stamp}-${journal.sessionId}-${toolCallId}`.replace(/[^A-Za-z0-9._-]/g, "_");
	const lessonPath = path.join(journal.journalDir, `${fileId}.md`);
	const tempPath = `${lessonPath}.tmp-${Bun.randomUUIDv7()}`;
	try {
		await fs.mkdir(journal.journalDir, { recursive: true });
		const handle = await fs.open(tempPath, "wx");
		try {
			await handle.writeFile(`${frontMatter}${body}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await journal.beforePublish?.(tempPath);
	} catch (error) {
		// A failure after the temp file is created (write, sync, beforePublish) leaves it for inspection; a mkdir or open failure leaves none. Either way it never reaches the lesson name.
		return journalError(`Failed to write lesson: ${String(error)}`, { action: params.action });
	}
	try {
		// link() fails with EEXIST rather than replacing: an existing lesson is never overwritten.
		await fs.link(tempPath, lessonPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		return journalError(`Failed to write lesson: ${String(error)}`, { action: params.action });
	}
	try {
		await fs.rm(tempPath, { force: true });
	} catch {
		// The lesson is already published; a leftover temp file must not fail the tool.
	}
	return {
		content: [{ type: "text", text: `Recorded lesson "${params.name}" (${params.action}) in ${lessonPath}.` }],
		details: { action: params.action, name: params.name, authored, path: lessonPath },
	};
}
