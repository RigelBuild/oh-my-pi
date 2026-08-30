import { REFRESH_SCOPES, type RefreshScope } from "../extensibility/reload";
import { summarizeRefresh } from "../tools/refresh";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/**
 * `/refresh [scope]` — the human surface for the `refresh` tool. Re-reads the
 * frozen-at-session-start config surfaces (skills, rules, settings/model, MCP)
 * into the live session without a restart. The scope argument is validated
 * against the single-sourced {@link REFRESH_SCOPES} before ever calling
 * `session.refresh`, so an unknown scope never reaches the orchestrator.
 */
export const BUILTIN_REFRESH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "refresh",
		description: "Re-read skills, rules, settings, and MCP from disk (no restart)",
		acpDescription: "Re-read config surfaces from disk without restarting",
		subcommands: [
			{ name: "skills", description: "Re-scan the skill roster" },
			{ name: "rules", description: "Re-scan the rule roster" },
			{ name: "settings", description: "Re-read settings + default model" },
			{ name: "mcp", description: "Reconnect MCP servers" },
			{ name: "all", description: "Every config surface (default)" },
		],
		acpInputHint: "[skills|rules|settings|mcp|all]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			const validScopes: readonly RefreshScope[] = REFRESH_SCOPES;
			const scope: RefreshScope = arg === "" ? "all" : (arg as RefreshScope);
			if (!validScopes.includes(scope)) {
				return usage(`Unknown refresh scope "${arg}". Use: ${validScopes.join(", ")}.`, runtime);
			}
			try {
				const result = await runtime.session.refresh(scope);
				await runtime.output(summarizeRefresh(scope, result));
			} catch (err) {
				return usage(`Refresh failed: ${errorMessage(err)}`, runtime);
			}
			return commandConsumed();
		},
	},
];
