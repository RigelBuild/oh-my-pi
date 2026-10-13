import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { checkPr, expectedNextVersion, mintTarget, parseTrackingVersion } from "./release-tag";

describe("parseTrackingVersion", () => {
	test("accepts X.Y.Z-rigel.N", () => {
		expect(parseTrackingVersion("18.9.2-rigel.1")).toEqual({ base: "18.9.2", n: 1n });
		expect(parseTrackingVersion("0.0.0-rigel.12")).toEqual({ base: "0.0.0", n: 12n });
	});

	test("rejects other shapes", () => {
		for (const bad of [
			"18.9.2",
			"v18.9.2-rigel.1",
			"18.9.2-rigel.0",
			"18.9.2-rigel.01",
			"01.9.2-rigel.1",
			"18.9.2-canary.1",
			"18.9.2-rigel.1 ",
		]) {
			expect(parseTrackingVersion(bad)).toBeNull();
		}
	});
});

describe("expectedNextVersion", () => {
	test("starts at rigel.1 for a new base", () => {
		expect(expectedNextVersion("18.9.2", ["v18.9.1-rigel.4", "v18.9.2"])).toBe("18.9.2-rigel.1");
	});

	test("increments from the highest N of the same base, numerically", () => {
		expect(expectedNextVersion("18.9.2", ["v18.9.2-rigel.9", "v18.9.2-rigel.10", "v18.9.2-rigel.2"])).toBe(
			"18.9.2-rigel.11",
		);
	});

	test("ignores malformed tags", () => {
		expect(expectedNextVersion("18.9.2", ["v18.9.2-rigel.01", "v18.9.2-rigel.x"])).toBe("18.9.2-rigel.1");
	});
});

async function repo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-tag-"));
	await $`git init -q -b rigel-release && git config user.email t@t && git config user.name t`.cwd(dir).quiet();
	return dir;
}

async function commit(dir: string, version?: string): Promise<string> {
	await fs.mkdir(path.join(dir, ".github"), { recursive: true });
	const file = path.join(dir, ".github/rigel-version");
	if (version === undefined) await fs.rm(file, { force: true });
	else await Bun.write(file, `${version}\n`);
	await Bun.write(path.join(dir, "n"), crypto.randomUUID());
	await $`git add -A && git commit -qm c`.cwd(dir).quiet();
	return (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
}

describe("mintTarget", () => {
	test("tags the oldest first-parent commit carrying the version", async () => {
		const dir = await repo();
		await commit(dir);
		const first = await commit(dir, "18.9.2-rigel.1");
		const head = await commit(dir, "18.9.2-rigel.1");
		expect(await mintTarget(dir, head)).toEqual({ tag: "v18.9.2-rigel.1", sha: first });
	});

	test("does nothing without a version file", async () => {
		const dir = await repo();
		const head = await commit(dir);
		expect(await mintTarget(dir, head)).toBeNull();
	});

	test("does nothing when the tag already exists", async () => {
		const dir = await repo();
		const head = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		expect(await mintTarget(dir, head)).toBeNull();
	});

	test("rejects a version that skips N", async () => {
		const dir = await repo();
		const head = await commit(dir, "18.9.2-rigel.2");
		await expect(mintTarget(dir, head)).rejects.toThrow("expected 18.9.2-rigel.1, got 18.9.2-rigel.2");
	});
});

describe("checkPr", () => {
	test("passes when the version file is unchanged", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		const head = await commit(dir, "18.9.2-rigel.1");
		expect(await checkPr(dir, base, head)).toBe("unchanged");
	});

	test("accepts the next version", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		const head = await commit(dir, "18.9.2-rigel.2");
		expect(await checkPr(dir, base, head)).toBe("18.9.2-rigel.2");
	});

	test("rejects a reused version", async () => {
		const dir = await repo();
		const base = await commit(dir);
		await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		const head = await commit(dir, "18.9.2-rigel.1");
		await expect(checkPr(dir, base, head)).rejects.toThrow("expected 18.9.2-rigel.2, got 18.9.2-rigel.1");
	});

	test("rejects a malformed version file", async () => {
		const dir = await repo();
		const base = await commit(dir);
		const head = await commit(dir, "18.9.2");
		await expect(checkPr(dir, base, head)).rejects.toThrow("X.Y.Z-rigel.N");
	});

	test("fails on a commit it cannot resolve instead of passing as unchanged", async () => {
		const dir = await repo();
		const head = await commit(dir, "18.9.2-rigel.1");
		await expect(checkPr(dir, "0".repeat(40), head)).rejects.toThrow("is not a commit");
	});
});
