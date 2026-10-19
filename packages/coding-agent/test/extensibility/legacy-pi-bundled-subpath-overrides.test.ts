import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { createLegacyPiVirtualModulePlugin } from "@oh-my-pi/pi-coding-agent/build";
import { __buildLegacyPiPackageRootOverrides } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";
import { __renderLegacyPiVirtualModule, collectBundledPiEntries } from "@oh-my-pi/pi-coding-agent/build";
import type { BundledPiEntry } from "@oh-my-pi/pi-coding-agent/build";

const bundledEntries = await collectBundledPiEntries();
const bundledModuleKeys = new Set(bundledEntries.map(entry => entry.key));

async function runRegistryProbe(entries: BundledPiEntry[], source: string): Promise<unknown> {
	// Bare package imports in the generated registry need the workspace links.
	const packageRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
	const registryPath = path.join(packageRoot, `.probe-legacy-pi-${Bun.randomUUIDv7()}.ts`);
	await Bun.write(registryPath, `${__renderLegacyPiVirtualModule(entries)}\n${source}\n`);
	try {
		// Runtime-selected registry filename: static imports cannot exercise its generated module.
		const registry = await import(url.pathToFileURL(registryPath).href);
		return registry.observed;
	} finally {
		await fs.rm(registryPath, { force: true });
	}
}

// Regression for issue #3442: extension validation in compiled-binary mode
// failed to resolve `@earendil-works/pi-ai/oauth` because the override map
// only covered bare package roots — every non-wildcard subpath fell through
// to `Bun.resolveSync`, which bunfs can't satisfy on Bun 1.3.14+, then the
// `rewriteLegacyPiImports` catch left the original specifier in place and
// Bun's native resolver couldn't find a peer install. The build plugin now
// derives every module key from current package exports, so subpaths route to
// the same `omp-legacy-pi-bundled:` virtual namespace as package roots without
// a generated registry or duplicate key list.
describe("legacy pi compat compiled-mode subpath overrides (issue #3442)", () => {
	it("keeps the build-only plugin out of legacy runtime loaders", () => {
		expect(bundledModuleKeys.has("@oh-my-pi/pi-coding-agent/build")).toBe(false);
	});

	it("resolves virtual imports from the SDK package when the build runs elsewhere", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-pi-build-");
		const entry = path.join(tempDir.path(), "entry.ts");
		const script = path.join(tempDir.path(), "build.ts");
		const pluginModule = path.join(import.meta.dir, "..", "..", "src", "build", "legacy-pi-virtual-module.ts");
		await Bun.write(entry, 'export { BUNDLED_PI_MODULE_LOADERS } from "omp-legacy-pi-modules";\n');
		await Bun.write(
			script,
			[
				`import { createLegacyPiVirtualModulePlugin } from ${JSON.stringify(pluginModule)};`,
				`const result = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], target: "bun", plugins: [await createLegacyPiVirtualModulePlugin()], external: ["@oh-my-pi/pi-natives"], throw: false });`,
				"if (!result.success) { console.error(result.logs.map(log => log.message).join('\\n')); process.exit(1); }",
			].join("\n"),
		);
		// Bun resolves bare imports from a relative importer against the process cwd.
		const build = Bun.spawnSync([process.execPath, script], { cwd: tempDir.path(), stderr: "pipe" });
		expect(build.exitCode, build.stderr.toString()).toBe(0);
	}, 60_000);

	it("does not embed the SDK checkout path when whitespace is preserved", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-pi-name-");
		const entry = path.join(tempDir.path(), "entry.ts");
		await Bun.write(entry, 'export { BUNDLED_PI_MODULE_LOADERS } from "omp-legacy-pi-modules";\n');
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			minify: { whitespace: false, syntax: true, identifiers: false },
			plugins: [await createLegacyPiVirtualModulePlugin()],
			external: ["*"],
			throw: false,
		});
		expect(result.success, result.logs.map(log => log.message).join("\n")).toBe(true);
		const output = await result.outputs[0]!.text();
		expect(output).toContain("BUNDLED_PI_MODULE_LOADERS");
		expect(output).not.toContain(path.join(import.meta.dir, "..", "..", "src", "build"));
	});

	it("keeps caller externals bare for registry imports", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-pi-external-");
		const entry = path.join(tempDir.path(), "entry.ts");
		await Bun.write(entry, 'export { BUNDLED_PI_MODULE_LOADERS } from "omp-legacy-pi-modules";\n');
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			plugins: [await createLegacyPiVirtualModulePlugin()],
			external: ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-ai/*"],
			throw: false,
		});
		expect(result.success, result.logs.map(log => log.message).join("\n")).toBe(true);
		const output = await result.outputs[0]!.text();
		expect(output).toContain('import("@oh-my-pi/pi-ai/oauth/anthropic")');
		expect(output).not.toMatch(/import\("[^"]*[\\/]ai[\\/]src[\\/]registry[\\/]oauth[\\/]anthropic\.ts"\)/);
	}, 60_000);

	it("does not evaluate unrelated host modules while loading the registry", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-pi-loaders-");
		const alphaPath = path.join(tempDir.path(), "alpha.ts");
		const betaPath = path.join(tempDir.path(), "beta.ts");
		const registryPath = path.join(tempDir.path(), "registry.ts");
		await Bun.write(alphaPath, 'Reflect.set(globalThis, "__alphaLoads", 1);\nexport const value = "alpha";\n');
		await Bun.write(betaPath, 'Reflect.set(globalThis, "__betaLoads", 1);\nexport const value = "beta";\n');
		const registry = __renderLegacyPiVirtualModule([
			{ key: "alpha", binding: "bundledAlpha", importSpecifier: url.pathToFileURL(alphaPath).href },
			{ key: "beta", binding: "bundledBeta", importSpecifier: url.pathToFileURL(betaPath).href },
		]);
		await Bun.write(
			registryPath,
			`${registry}
export const beforeAlpha = Reflect.get(globalThis, "__alphaLoads") ?? 0;
export const beforeBeta = Reflect.get(globalThis, "__betaLoads") ?? 0;
await BUNDLED_PI_MODULE_LOADERS.alpha();
export const afterAlpha = Reflect.get(globalThis, "__alphaLoads") ?? 0;
export const betaAfterAlpha = Reflect.get(globalThis, "__betaLoads") ?? 0;
await BUNDLED_PI_MODULE_LOADERS.beta();
export const finalAlpha = Reflect.get(globalThis, "__alphaLoads") ?? 0;
export const finalBeta = Reflect.get(globalThis, "__betaLoads") ?? 0;
`,
		);
		Reflect.deleteProperty(globalThis, "__alphaLoads");
		Reflect.deleteProperty(globalThis, "__betaLoads");
		try {
			// The generated registry has a runtime-selected temp path; importing it is the loading boundary under test.
			const observed = await import(url.pathToFileURL(registryPath).href);
			expect([
				observed.beforeAlpha,
				observed.beforeBeta,
				observed.afterAlpha,
				observed.betaAfterAlpha,
				observed.finalAlpha,
				observed.finalBeta,
			]).toEqual([0, 0, 1, 0, 1, 1]);
		} finally {
			Reflect.deleteProperty(globalThis, "__alphaLoads");
			Reflect.deleteProperty(globalThis, "__betaLoads");
		}
	});

	it("serves @oh-my-pi/pi-ai/oauth through the bundled virtual namespace in compiled mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides["@oh-my-pi/pi-ai/oauth"]).toBe("omp-legacy-pi-bundled:@oh-my-pi/pi-ai/oauth");
	});

	it("expands wildcard exports for concrete on-disk targets (issue #3442 follow-up)", () => {
		// `pi-ai/oauth/anthropic` is exposed via the `./oauth/*` wildcard export;
		// the original fix only bundled non-wildcard subpaths, so peer-only plugins
		// importing `@(scope)/pi-ai/oauth/anthropic` (remapped via PI_SUBPATH_REMAPS
		// from `@mariozechner/pi-ai/utils/oauth/anthropic`) still hit the bunfs
		// fall-through. The generator now globs each wildcard's source pattern
		// and registers every concrete `.ts` match against the virtual namespace.
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides["@oh-my-pi/pi-ai/oauth/anthropic"]).toBe(
			"omp-legacy-pi-bundled:@oh-my-pi/pi-ai/oauth/anthropic",
		);
		// Sanity: the wildcard expansion also reaches deeper subroots so plugins
		// pinned to e.g. `@oh-my-pi/pi-ai/providers/openai` keep resolving.
		expect(bundledModuleKeys.has("@oh-my-pi/pi-ai/oauth/anthropic")).toBe(true);
		expect(bundledModuleKeys.has("@oh-my-pi/pi-ai/oauth/openai-codex")).toBe(true);
	});

	it("actually loads the shim's shared Pi translation through the bundled registry", async () => {
		// The legacy shim performs the same Pi arg translation as the modern
		// bridge and imports the shared helpers rather than copying them. Those
		// use the explicit single-segment `providers/cursor-pi-args` target; wildcard
		// exports may also match nested paths, whose registry coverage is tested below.
		//
		// Executing the generated registry is the contract — a key present in the
		// override map still proves nothing if the module cannot be imported.
		const key = "@oh-my-pi/pi-ai/providers/cursor-pi-args";
		const entry = bundledEntries.find(candidate => candidate.key === key);
		expect(entry).toBeDefined();

		expect(
			await runRegistryProbe(
				[entry!],
				`const mod = await BUNDLED_PI_MODULE_LOADERS[${JSON.stringify(key)}]();
export const observed = [mod.piEscapeRegexLiteral("a.b*c"), mod.piJoinPath("src", "*.ts")];`,
			),
		).toEqual(["a\\.b\\*c", path.join("src", "*.ts")]);

		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("loads catalog root and provider-model exports from the bundled graph", async () => {
		const root = bundledEntries.find(entry => entry.key === "@oh-my-pi/pi-catalog");
		const provider = bundledEntries.find(entry => entry.key === "@oh-my-pi/pi-catalog/provider-models");
		if (!root || !provider) throw new Error("Catalog imports are missing from the bundled registry");

		const observed = await runRegistryProbe(
			[root, provider],
			`const catalog = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-catalog"]();
const providers = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-catalog/provider-models"]();
const result = await catalog.createModelManager(providers.anthropicModelManagerOptions()).refresh("offline");
export const observed = result.models.some(model => model.id === "claude-3-5-sonnet-20240620");`,
		);
		expect(observed).toBe(true);
	});

	it("loads catalog build exports through the bundled registry in compiled mode", async () => {
		const key = "@oh-my-pi/pi-catalog/build";
		const entry = bundledEntries.find(candidate => candidate.key === key);
		if (!entry) throw new Error("Catalog build import is missing from the bundled registry");

		const observed = await runRegistryProbe(
			[entry],
			`const { buildModel } = await BUNDLED_PI_MODULE_LOADERS[${JSON.stringify(key)}]();
export const observed = buildModel({
	id: "custom-model",
	name: "OpenAI: Sample (latest)",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://api.example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
}).name;`,
		);
		expect(observed).toBe("Sample");
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("loads catalog .js aliases from the bundled graph", async () => {
		const key = "@oh-my-pi/pi-catalog/build.js";
		const entry = bundledEntries.find(candidate => candidate.key === key);
		if (!entry) throw new Error("Catalog build.js alias is missing from the bundled registry");
		const observed = await runRegistryProbe(
			[entry],
			`const { buildModel } = await BUNDLED_PI_MODULE_LOADERS[${JSON.stringify(key)}]();
export const observed = buildModel({ id: "alias", name: "OpenAI: Alias (latest)", api: "openai-completions", provider: "custom", baseUrl: "https://api.example.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }).name;`,
		);
		expect(observed).toBe("Alias");
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("expands web search provider wildcard exports for compiled plugin imports", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		const providerKeys = [
			"@oh-my-pi/pi-coding-agent/web/search/providers/xai",
			"@oh-my-pi/pi-coding-agent/web/search/providers/tinyfish",
			"@oh-my-pi/pi-coding-agent/web/search/providers/firecrawl",
			"@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo",
		] as const;

		for (const key of providerKeys) {
			expect(bundledModuleKeys.has(key)).toBe(true);
			expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
		}
	});

	it("serves coding-agent registry wildcard exports in compiled mode", () => {
		const key = "@oh-my-pi/pi-coding-agent/registry/agent-registry";
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(bundledModuleKeys.has(key)).toBe(true);
		expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("keeps non-catalog root catch-all wildcards (./* / ./*.js) out of the bundle", () => {
		// Other packages expose CLI entrypoints at the root; importing one from
		// the virtual registry would expand the binary entry's transitive graph.
		expect(bundledModuleKeys.has("@oh-my-pi/pi-coding-agent/cli")).toBe(false);
		expect(bundledModuleKeys.has("@oh-my-pi/pi-coding-agent/main")).toBe(false);
	});

	it("does not bundle main-thread-unsafe worker entrypoints", () => {
		// Worker entry modules throw at top level unless `parentPort` exists.
		// The compiled legacy registry is imported on the main thread while
		// validating plugin extensions, so enumerating these files recreates the
		// `js worker-entry: missing parentPort` failure from #3508.
		expect(bundledModuleKeys.has("@oh-my-pi/pi-coding-agent/eval/js/worker-entry")).toBe(false);
	});

	it("maps every bundled key (minus shimmed roots + typebox) to its virtual specifier in compiled mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		const missing: string[] = [];
		for (const key of bundledModuleKeys) {
			// pi-ai/pi-coding-agent/pi-tui roots intentionally use the legacy compat
			// shims (they re-attach `Type`, `defineTool`, `decodeKittyPrintable`, etc.
			// dropped from the canonical package surfaces); typebox is served via
			// TYPEBOX_SHIM_PATH.
			if (
				key === "@oh-my-pi/pi-ai" ||
				key === "@oh-my-pi/pi-coding-agent" ||
				key === "@oh-my-pi/pi-tui" ||
				key === "typebox"
			)
				continue;
			if (overrides[key] !== `omp-legacy-pi-bundled:${key}`) {
				missing.push(key);
			}
		}
		expect(missing).toEqual([]);
	});

	it("does not register subpath overrides in dev/install mode", () => {
		const overrides = __buildLegacyPiPackageRootOverrides(false);
		expect(overrides).not.toHaveProperty("@oh-my-pi/pi-ai/oauth");
		expect(overrides).not.toHaveProperty("@oh-my-pi/pi-coding-agent/tools");
		// Dev keeps only the historical shim entries so canonical subpath
		// imports continue to flow through `Bun.resolveSync` against the live
		// monorepo / installed `node_modules` tree.
	});

	it("never emits a virtual specifier for typebox via the override map", () => {
		// typebox is routed through `TYPEBOX_SHIM_PATH` + a dedicated onResolve
		// hook; mirroring it in the override map would double-register and the
		// virtual loader would race the dedicated shim path.
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides).not.toHaveProperty("typebox");
	});

	it("bundles nested wildcard subpaths so a compiled extension can import them", () => {
		// Node matches `*` in an `exports` pattern across `/`, so
		// `./slash-commands/*` genuinely serves
		// `slash-commands/helpers/active-oauth-account`. Enumerating only the
		// top level left every nested key out of the compiled registry, so the
		// import resolved from source and failed inside a binary — which is how
		// a real extension (`quota-hud.ts`) broke on this exact specifier.
		expect(bundledModuleKeys.has("@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account")).toBe(true);
		// Directory index modules stay excluded: `./x/*` must not serve `x/y`
		// from `y/index.ts`, which Node would not resolve either.
		expect(bundledModuleKeys.has("@oh-my-pi/pi-tui/theme/defaults/index")).toBe(false);
	});

	it("loads pi-tui native/* modules through the bundled registry in compiled mode (issue #14834)", async () => {
		// `native/*` was only reachable through pi-tui's root `./*` catch-all, which
		// the generator skips, so extensions importing it failed inside the binary.
		const keys = ["@oh-my-pi/pi-tui/native/overlay", "@oh-my-pi/pi-tui/native/spans"] as const;
		const entries = bundledEntries.filter(entry => (keys as readonly string[]).includes(entry.key));
		expect(entries.map(entry => entry.key).sort()).toEqual([...keys]);

		const observed = await runRegistryProbe(
			entries,
			`const { actionBar, actionButton } = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/native/overlay"]();
const { plainLine } = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/native/spans"]();
export const observed = { role: actionBar([actionButton("Go", "go")]).p.role, line: plainLine("\\x1b[1ma\\n b\\x1b[0m") };`,
		);
		expect(observed).toEqual({ role: "omp.actions", line: "a b" });
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		for (const key of keys) expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});
	it("collects canonical keys with installed Rigel specifiers", async () => {
		using tempDir = TempDir.createSync("@omp-rigel-pi-packages-");
		const fakePackageDir = path.join(tempDir.path(), "node_modules", "@rigelbuild", "omp-coding-agent");
		const packageNames = ["agent-core", "ai", "catalog", "coding-agent", "natives", "tui", "utils"];
		await fs.mkdir(fakePackageDir, { recursive: true });
		await Bun.write(
			path.join(fakePackageDir, "package.json"),
			JSON.stringify({ name: "@rigelbuild/omp-coding-agent", exports: { ".": "./index.ts" } }),
		);
		for (const packageName of packageNames) {
			const packageRoot = path.join(tempDir.path(), "node_modules", "@rigelbuild", `omp-${packageName}`);
			await fs.mkdir(packageRoot, { recursive: true });
			await Bun.write(
				path.join(packageRoot, "package.json"),
				JSON.stringify({
					name: `@rigelbuild/omp-${packageName}`,
					exports: { ".": "./index.ts", "./probe": "./probe.ts" },
				}),
			);
			await Bun.write(
				path.join(packageRoot, "index.ts"),
				`export const packageName = ${JSON.stringify(packageName)};`,
			);
			await Bun.write(path.join(packageRoot, "probe.ts"), `export const probe = ${JSON.stringify(packageName)};`);
		}

		const entries = await collectBundledPiEntries(fakePackageDir);
		const entryByKey = new Map(entries.map(entry => [entry.key, entry]));
		expect(entries.every(entry => entry.key === "typebox" || entry.key.startsWith("@oh-my-pi/pi-"))).toBe(true);
		expect(entryByKey.get("@oh-my-pi/pi-agent-core")?.importSpecifier).toBe("@rigelbuild/omp-agent-core");
		expect(entryByKey.get("@oh-my-pi/pi-coding-agent/probe")?.importSpecifier).toBe(
			"@rigelbuild/omp-coding-agent/probe",
		);
		expect(entryByKey.get("@oh-my-pi/pi-coding-agent/probe")?.key).toBe("@oh-my-pi/pi-coding-agent/probe");
		expect(entryByKey.get("@oh-my-pi/pi-natives/probe")?.importSpecifier).toBe("@rigelbuild/omp-natives/probe");
		expect(entryByKey.get("@oh-my-pi/pi-tui/probe")?.importSpecifier).toBe("@rigelbuild/omp-tui/probe");
		expect(entryByKey.get("@oh-my-pi/pi-utils")?.importSpecifier).toBe("@rigelbuild/omp-utils");
		expect(entryByKey.get("@oh-my-pi/pi-utils/probe")?.importSpecifier).toBe("@rigelbuild/omp-utils/probe");
		expect(Bun.resolveSync("@rigelbuild/omp-agent-core", fakePackageDir)).toBe(
			path.join(tempDir.path(), "node_modules", "@rigelbuild", "omp-agent-core", "index.ts"),
		);
		expect(Bun.resolveSync("@rigelbuild/omp-utils/probe", fakePackageDir)).toBe(
			path.join(tempDir.path(), "node_modules", "@rigelbuild", "omp-utils", "probe.ts"),
		);
	});

	it("preserves upstream registry output", () => {
		const packageDir = path.resolve(import.meta.dir, "../..");
		const shimSpecifiers: Record<string, string> = {
			"@oh-my-pi/pi-ai": path.join(packageDir, "src", "extensibility", "legacy-pi-ai-shim.ts"),
			"@oh-my-pi/pi-coding-agent": path.join(packageDir, "src", "extensibility", "legacy-pi-coding-agent-shim.ts"),
			"@oh-my-pi/pi-tui": path.join(packageDir, "src", "extensibility", "legacy-pi-tui-shim.ts"),
			typebox: path.join(packageDir, "src", "extensibility", "legacy-typebox.ts"),
		};
		const upstreamEntries = bundledEntries.map(entry => ({
			...entry,
			importSpecifier: shimSpecifiers[entry.key] ?? entry.key,
		}));
		expect(__renderLegacyPiVirtualModule(bundledEntries)).toBe(__renderLegacyPiVirtualModule(upstreamEntries));
	});
});
