import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	assertNoRenameCollisions,
	renamePackageName,
	renameSegment,
	renameTarballScope,
	rewriteModuleSpecifiers,
	rewriteText,
} from "./rigel-scope-rename.ts";

describe("renameSegment", () => {
	it("strips a leading pi- prefix", () => {
		expect(renameSegment("pi-utils")).toBe("@rigelbuild/omp-utils");
		expect(renameSegment("pi-coding-agent")).toBe("@rigelbuild/omp-coding-agent");
	});
	it("strips a leading omp- prefix without doubling", () => {
		expect(renameSegment("omp-stats")).toBe("@rigelbuild/omp-stats");
	});
	it("leaves an unprefixed segment intact under the new scope", () => {
		expect(renameSegment("hashline")).toBe("@rigelbuild/omp-hashline");
		expect(renameSegment("snapcompact")).toBe("@rigelbuild/omp-snapcompact");
		expect(renameSegment("omptype")).toBe("@rigelbuild/omp-omptype");
	});
	it("renames per-platform native leaf segments", () => {
		expect(renameSegment("pi-natives-linux-x64")).toBe("@rigelbuild/omp-natives-linux-x64");
		expect(renameSegment("pi-natives-win32-x64")).toBe("@rigelbuild/omp-natives-win32-x64");
	});
});

describe("renamePackageName", () => {
	it("renames a full @oh-my-pi identifier", () => {
		expect(renamePackageName("@oh-my-pi/pi-catalog")).toBe("@rigelbuild/omp-catalog");
		expect(renamePackageName("@oh-my-pi/pi-natives")).toBe("@rigelbuild/omp-natives");
	});
	it("leaves names outside the upstream scope untouched", () => {
		expect(renamePackageName("@rigelbuild/omp-utils")).toBe("@rigelbuild/omp-utils");
		expect(renamePackageName("typescript")).toBe("typescript");
		expect(renamePackageName("@types/node")).toBe("@types/node");
	});
});

describe("rewriteText", () => {
	it("rewrites bare import specifiers", () => {
		expect(rewriteText('import { x } from "@oh-my-pi/pi-utils";')).toBe('import { x } from "@rigelbuild/omp-utils";');
	});
	it("preserves subpath imports", () => {
		expect(rewriteText('from "@oh-my-pi/omptype/ark"')).toBe('from "@rigelbuild/omp-omptype/ark"');
		expect(rewriteText('from "@oh-my-pi/pi-agent-core/compaction/entries"')).toBe(
			'from "@rigelbuild/omp-agent-core/compaction/entries"',
		);
	});
	it("rewrites every occurrence in a manifest dependency block", () => {
		expect(rewriteText('"@oh-my-pi/pi-natives":"1","@oh-my-pi/omptype":"1"')).toBe(
			'"@rigelbuild/omp-natives":"1","@rigelbuild/omp-omptype":"1"',
		);
	});
	it("leaves text without the upstream scope unchanged", () => {
		expect(rewriteText("no scope here")).toBe("no scope here");
		expect(rewriteText("@rigelbuild/omp-utils already renamed")).toBe("@rigelbuild/omp-utils already renamed");
	});
});

describe("rewriteModuleSpecifiers", () => {
	it("rewrites import/export/require/dynamic specifier contexts", () => {
		expect(rewriteModuleSpecifiers('import { x } from "@oh-my-pi/pi-utils";')).toBe(
			'import { x } from "@rigelbuild/omp-utils";',
		);
		expect(rewriteModuleSpecifiers('export { y } from "@oh-my-pi/pi-utils/format"')).toBe(
			'export { y } from "@rigelbuild/omp-utils/format"',
		);
		expect(rewriteModuleSpecifiers('require("@oh-my-pi/pi-ai")')).toBe('require("@rigelbuild/omp-ai")');
		expect(rewriteModuleSpecifiers('await import("@oh-my-pi/pi-catalog/models")')).toBe(
			'await import("@rigelbuild/omp-catalog/models")',
		);
	});
	it("rewrites minified specifier forms without surrounding whitespace", () => {
		expect(rewriteModuleSpecifiers('import*as cg from"@oh-my-pi/pi-natives"')).toBe(
			'import*as cg from"@rigelbuild/omp-natives"',
		);
		expect(rewriteModuleSpecifiers('import{astMatch as LAi}from"@oh-my-pi/pi-natives"')).toBe(
			'import{astMatch as LAi}from"@rigelbuild/omp-natives"',
		);
	});
	it("rewrites declare-module augmentation targets, subpath preserved", () => {
		expect(rewriteModuleSpecifiers('declare module "@oh-my-pi/pi-agent-core" {')).toBe(
			'declare module "@rigelbuild/omp-agent-core" {',
		);
		expect(rewriteModuleSpecifiers('declare module "@oh-my-pi/pi-agent-core/compaction/entries" {')).toBe(
			'declare module "@rigelbuild/omp-agent-core/compaction/entries" {',
		);
	});
	it("leaves string literals and prose that merely contain the scope untouched", () => {
		expect(rewriteModuleSpecifiers('const CANONICAL_PI_SCOPE = "@oh-my-pi";')).toBe(
			'const CANONICAL_PI_SCOPE = "@oh-my-pi";',
		);
		expect(rewriteModuleSpecifiers("plugin install @oh-my-pi/exa")).toBe("plugin install @oh-my-pi/exa");
		expect(rewriteModuleSpecifiers("// resolve node_modules/@oh-my-pi/pi-*")).toBe(
			"// resolve node_modules/@oh-my-pi/pi-*",
		);
		expect(rewriteModuleSpecifiers("You can declare module boundaries for @oh-my-pi packages")).toBe(
			"You can declare module boundaries for @oh-my-pi packages",
		);
	});
});

describe("assertNoRenameCollisions", () => {
	it("passes for the live closure shape (distinct targets)", () => {
		expect(() =>
			assertNoRenameCollisions([
				"@oh-my-pi/pi-utils",
				"@oh-my-pi/omptype",
				"@oh-my-pi/omp-stats",
				"@oh-my-pi/pi-natives",
				"@oh-my-pi/pi-natives-linux-x64",
			]),
		).not.toThrow();
	});
	it("throws when two upstream names collapse to one target", () => {
		expect(() => assertNoRenameCollisions(["@oh-my-pi/pi-stats", "@oh-my-pi/omp-stats"])).toThrow("Rename collision");
	});
	it("ignores names outside the upstream scope", () => {
		expect(() => assertNoRenameCollisions(["typescript", "@types/node", "@rigelbuild/omp-utils"])).not.toThrow();
	});
});

describe("renameTarballScope", () => {
	it("rewrites manifest name, deps, and shipped source in a packed tarball", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rename-tgz-"));
		try {
			const stage = path.join(root, "package");
			await fs.mkdir(path.join(stage, "src"), { recursive: true });
			await fs.writeFile(
				path.join(stage, "package.json"),
				`${JSON.stringify(
					{
						name: "@oh-my-pi/pi-catalog",
						version: "18.0.3",
						dependencies: { "@oh-my-pi/omptype": "18.0.3", "@oh-my-pi/pi-utils": "18.0.3" },
					},
					null,
					"\t",
				)}\n`,
			);
			await fs.writeFile(path.join(stage, "src", "index.ts"), 'import { type } from "@oh-my-pi/omptype";\n');
			const binaryBytes = Buffer.from([0x00, 0x01, 0x40, 0x6f, 0x68, 0x00, 0xff]);
			await fs.writeFile(path.join(stage, "src", "addon.node"), binaryBytes);
			await fs.writeFile(
				path.join(stage, "src", "augment.ts"),
				'declare module "@oh-my-pi/pi-agent-core" {\n\tinterface X {}\n}\n',
			);
			await fs.mkdir(path.join(stage, "bin"));
			await fs.writeFile(path.join(stage, "bin", "cli.js"), 'import x from "@oh-my-pi/pi-utils";\n', {
				mode: 0o755,
			});
			const tgz = path.join(root, "pkg.tgz");
			await $`tar -czf ${tgz} -C ${root} package`.quiet();
			await renameTarballScope(tgz);
			const extract = path.join(root, "out");
			await fs.mkdir(extract);
			await $`tar -xzf ${tgz} -C ${extract}`.quiet();
			const out = path.join(extract, "package");
			const manifest = JSON.parse(await fs.readFile(path.join(out, "package.json"), "utf8"));
			expect(manifest.name).toBe("@rigelbuild/omp-catalog");
			expect(manifest.dependencies).toEqual({
				"@rigelbuild/omp-omptype": "18.0.3",
				"@rigelbuild/omp-utils": "18.0.3",
			});
			expect(manifest.version).toBe("18.0.3");
			expect(await fs.readFile(path.join(out, "src", "index.ts"), "utf8")).toContain(
				'from "@rigelbuild/omp-omptype"',
			);
			expect(Buffer.compare(await fs.readFile(path.join(out, "src", "addon.node")), binaryBytes)).toBe(0);
			expect(await fs.readFile(path.join(out, "src", "augment.ts"), "utf8")).toContain(
				'declare module "@rigelbuild/omp-agent-core"',
			);
			expect((await fs.stat(path.join(out, "bin", "cli.js"))).mode & 0o111).not.toBe(0);
			expect(await fs.readFile(path.join(out, "bin", "cli.js"), "utf8")).toContain('from "@rigelbuild/omp-utils"');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
