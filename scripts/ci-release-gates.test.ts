// Evaluates the release jobs' `if:` gates in .github/workflows/ci.yml with GitHub's own
// expression engine, for the fork and for upstream.
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";

const CI_YML = path.join(import.meta.dir, "../.github/workflows/ci.yml");
const FORK = "RigelBuild/oh-my-pi";
const UPSTREAM = "can1357/oh-my-pi";

interface Job {
	if?: string;
	needs?: string[];
}

function parseJobs(text: string): Record<string, Job> {
	const doc: unknown = Bun.YAML.parse(text);
	if (!doc || typeof doc !== "object" || !("jobs" in doc) || !doc.jobs || typeof doc.jobs !== "object") {
		throw new Error("ci.yml has no jobs map");
	}
	const jobs: Record<string, Job> = {};
	for (const [name, raw] of Object.entries(doc.jobs)) {
		if (!raw || typeof raw !== "object") continue;
		const job: Job = {};
		if ("if" in raw && typeof raw.if === "string") job.if = raw.if;
		if ("needs" in raw && Array.isArray(raw.needs)) {
			job.needs = raw.needs.filter((n: unknown): n is string => typeof n === "string");
		}
		jobs[name] = job;
	}
	return jobs;
}

const jobs = parseJobs(await Bun.file(CI_YML).text());

function dict(record: Record<string, data.ExpressionData>): data.Dictionary {
	return new data.Dictionary(...Object.entries(record).map(([key, value]) => ({ key, value })));
}

const statusFunctions = new Map(
	(["cancelled", "failure", "success", "always"] as const).map(name => [
		name,
		{
			name,
			description: "",
			minArgs: 0,
			maxArgs: 0,
			// No run in these tests is cancelled; the other status functions aren't used by these gates.
			call: () => new data.BooleanData(name === "always"),
		},
	]),
);

function gate(job: string, repository: string, results: Record<string, string>): boolean {
	const source = jobs[job]?.if;
	if (!source) throw new Error(`${job} has no if:`);
	const expr = source.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
	const needs: Record<string, data.ExpressionData> = {
		release_metadata: dict({
			result: new data.StringData("success"),
			outputs: dict({ "is-release": new data.StringData("true"), channel: new data.StringData("stable") }),
		}),
	};
	for (const name of jobs[job]?.needs ?? []) {
		if (name !== "release_metadata") needs[name] = dict({ result: new data.StringData(results[name] ?? "success") });
	}
	const context = dict({
		github: dict({ repository: new data.StringData(repository) }),
		needs: dict(needs),
		inputs: dict({ skip_npm: new data.BooleanData(false) }),
	});
	const lexed = new Lexer(expr).lex();
	const parsed = new Parser(lexed.tokens, ["github", "needs", "inputs"], [...statusFunctions.values()]).parse();
	return truthy(new Evaluator(parsed, context, statusFunctions).evaluate());
}

/** Resolves release_build, then the jobs that depend on it, as GitHub would. */
function release(repository: string, failing?: string): Record<string, boolean | string> {
	const results: Record<string, string> = {};
	if (failing && failing !== "release_build") results[failing] = "failure";
	const buildRuns = gate("release_build", repository, results);
	results.release_build = failing === "release_build" ? "failure" : buildRuns ? "success" : "skipped";
	return {
		build: results.release_build,
		npm: gate("release_npm", repository, results),
		brew: gate("release_brew", repository, results),
	};
}

describe("release gates on the fork", () => {
	test("skips build.stencil.so and brew but publishes npm", () => {
		expect(release(FORK)).toEqual({ build: "skipped", npm: true, brew: false });
	});

	for (const failing of [
		"release_gate",
		"release_github",
		"release_binary",
		"release_smoke",
		"release_native_leaves",
	]) {
		test(`a failed ${failing} blocks npm`, () => {
			expect(release(FORK, failing).npm).toBe(false);
		});
	}
});

describe("release gates upstream", () => {
	test("publishes build.stencil.so, npm, and brew", () => {
		expect(release(UPSTREAM)).toEqual({ build: "success", npm: true, brew: true });
	});

	for (const failing of ["release_gate", "release_github", "release_build"]) {
		test(`a failed ${failing} blocks npm and brew`, () => {
			expect(release(UPSTREAM, failing)).toMatchObject({ npm: false, brew: false });
		});
	}
});
