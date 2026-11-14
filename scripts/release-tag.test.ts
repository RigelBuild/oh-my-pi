import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { checkPr, createTag, expectedNextVersion, mintTarget, parseTrackingVersion, type TagApi } from "./release-tag";

const RELEASE_VERSION = "18.9.2-rigel.2";

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
	test("increments from rigel.3 to rigel.4", () => {
		expect(expectedNextVersion("18.18.3", ["v18.18.3-rigel.3"])).toBe("18.18.3-rigel.4");
	});
});

async function repo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-tag-"));
	await $`git init -q -b rigel-release && git config user.email t@t && git config user.name t`.cwd(dir).quiet();
	return dir;
}

async function commit(dir: string, version?: string, stamp = false): Promise<string> {
	await fs.mkdir(path.join(dir, ".github"), { recursive: true });
	const file = path.join(dir, ".github/rigel-version");
	if (version === undefined) await fs.rm(file, { force: true });
	else await Bun.write(file, `${version}\n`);
	if (stamp) {
		await fs.mkdir(path.join(dir, "packages", "coding-agent"), { recursive: true });
		await Bun.write(
			path.join(dir, "packages", "coding-agent", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }, null, "\t"),
		);
		await fs.mkdir(path.join(dir, "packages", "public"), { recursive: true });
		await Bun.write(
			path.join(dir, "packages", "public", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/public", version }, null, "\t"),
		);
		await fs.mkdir(path.join(dir, "packages", "private"), { recursive: true });
		await Bun.write(
			path.join(dir, "packages", "private", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/private", version: "0.0.1", private: true }),
		);
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ workspaces: { catalog: { "@oh-my-pi/public": version } } }),
		);
		await Bun.write(path.join(dir, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`);
		await Bun.write(
			path.join(dir, "Cargo.lock"),
			`[[package]]\nname = "registry-pi-crate"\nversion = "0.1.0"\nsource = "registry+https://example.invalid"\n\n[[package]]\nname = "workspace-crate"\nversion = "${version}"\n`,
		);
	}
	await Bun.write(path.join(dir, "n"), crypto.randomUUID());
	await $`git add -A && git commit -qm c`.cwd(dir).quiet();
	return (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
}

describe("mintTarget", () => {
	test("tags the oldest first-parent commit carrying the version", async () => {
		const dir = await repo();
		await commit(dir);
		const first = await commit(dir, "18.9.2-rigel.1", true);
		const head = await commit(dir, "18.9.2-rigel.1", true);
		expect(await mintTarget(dir, head)).toEqual({ tag: "v18.9.2-rigel.1", sha: first });
	});

	test("does nothing without a version file", async () => {
		const dir = await repo();
		const head = await commit(dir);
		expect(await mintTarget(dir, head)).toBeNull();
	});

	test("does nothing when the tag already marks the introducing commit", async () => {
		const dir = await repo();
		const first = await commit(dir, "18.9.2-rigel.1", true);
		await $`git tag -a -m r v18.9.2-rigel.1 ${first}`.cwd(dir).quiet();
		const head = await commit(dir, "18.9.2-rigel.1", true);
		expect(await mintTarget(dir, head)).toBeNull();
	});

	test("fails when a second PR reintroduces an already-tagged version", async () => {
		const dir = await repo();
		const first = await commit(dir, "18.9.2-rigel.1", true);
		await $`git tag v18.9.2-rigel.1 ${first}`.cwd(dir).quiet();
		await commit(dir);
		const head = await commit(dir, "18.9.2-rigel.1", true);
		await expect(mintTarget(dir, head)).rejects.toThrow(
			`v18.9.2-rigel.1 already exists at ${first}, but ${head} introduced 18.9.2-rigel.1`,
		);
	});
	test("rejects minting an unstamped release", async () => {
		const dir = await repo();
		const head = await commit(dir, "18.9.2-rigel.1");
		await expect(mintTarget(dir, head)).rejects.toThrow("no public package manifests");
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

	test("rejects a mismatched package version and names the manifest", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		await commit(dir, RELEASE_VERSION, true);
		await Bun.write(
			path.join(dir, "packages", "public", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/public", version: "18.9.2" }),
		);
		await $`git add -A && git commit -qm mismatch`.cwd(dir).quiet();
		await expect(checkPr(dir, base, (await $`git rev-parse HEAD`.cwd(dir).text()).trim())).rejects.toThrow(
			"packages/public/package.json",
		);
	});

	test("accepts matching package and catalog stamps", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		const head = await commit(dir, RELEASE_VERSION, true);
		expect(await checkPr(dir, base, head)).toBe(RELEASE_VERSION);
	});
	test("validates the release commit even when checkout packages are absent", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		const head = await commit(dir, RELEASE_VERSION, true);
		await fs.rm(path.join(dir, "packages"), { recursive: true });
		expect(await checkPr(dir, base, head)).toBe(RELEASE_VERSION);
	});

	test("rejects a bump missing the coding-agent manifest", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		await commit(dir, RELEASE_VERSION, true);
		await fs.rm(path.join(dir, "packages", "coding-agent"), { recursive: true });
		const head = await commit(dir, RELEASE_VERSION);
		await expect(checkPr(dir, base, head)).rejects.toThrow("packages/coding-agent/package.json");
	});

	test("rejects a stale Cargo.lock workspace version", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		await commit(dir, RELEASE_VERSION, true);
		const lock = path.join(dir, "Cargo.lock");
		const contents = await fs.readFile(lock, "utf8");
		await Bun.write(lock, contents.replace(RELEASE_VERSION, "18.9.2"));
		const head = await commit(dir, RELEASE_VERSION);
		await expect(checkPr(dir, base, head)).rejects.toThrow("Cargo.lock");
	});
	test("rejects a stale Cargo.toml workspace version", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		await commit(dir, RELEASE_VERSION, true);
		const cargo = path.join(dir, "Cargo.toml");
		const contents = await fs.readFile(cargo, "utf8");
		await Bun.write(cargo, contents.replace(RELEASE_VERSION, "18.9.2"));
		const head = await commit(dir, RELEASE_VERSION);
		await expect(checkPr(dir, base, head)).rejects.toThrow(`do not match ${RELEASE_VERSION}: Cargo.toml`);
	});
	test("rejects a catalog-only mismatch", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		await commit(dir, RELEASE_VERSION, true);
		const root = path.join(dir, "package.json");
		const contents = await fs.readFile(root, "utf8");
		await Bun.write(root, contents.replace(RELEASE_VERSION, "18.9.2"));
		await $`git add -A && git commit -qm mismatch`.cwd(dir).quiet();
		const head = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
		await expect(checkPr(dir, base, head)).rejects.toThrow(`do not match ${RELEASE_VERSION}: package.json`);
	});

	test("rejects a bump with no public package manifests", async () => {
		const dir = await repo();
		const base = await commit(dir, "18.9.2-rigel.1");
		await $`git tag v18.9.2-rigel.1`.cwd(dir).quiet();
		await fs.mkdir(path.join(dir, "packages", "coding-agent"), { recursive: true });
		await Bun.write(
			path.join(dir, "packages", "coding-agent", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: RELEASE_VERSION, private: true }),
		);
		const head = await commit(dir, RELEASE_VERSION);
		await expect(checkPr(dir, base, head)).rejects.toThrow("no public package manifests");
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

/** A ref store where another minter may create the tag between our read and our create. */
function fakeApi(initial: string | null, racer?: string): TagApi & { created: string[] } {
	let ref = initial;
	const created: string[] = [];
	return {
		created,
		async get() {
			return ref;
		},
		async create(_tag, sha) {
			if (racer !== undefined) {
				ref = racer;
				return "exists";
			}
			ref = sha;
			created.push(sha);
			return "created";
		},
	};
}

describe("createTag", () => {
	test("creates a missing tag", async () => {
		const api = fakeApi(null);
		expect(await createTag(api, "v1.0.0-rigel.1", "aaa")).toBe("created");
		expect(api.created).toEqual(["aaa"]);
	});

	test("accepts a tag a concurrent run created at the same commit", async () => {
		expect(await createTag(fakeApi(null, "aaa"), "v1.0.0-rigel.1", "aaa")).toBe("present");
	});

	test("fails when a concurrent run created the tag elsewhere", async () => {
		await expect(createTag(fakeApi(null, "bbb"), "v1.0.0-rigel.1", "aaa")).rejects.toThrow(
			"already exists at bbb, expected aaa",
		);
	});

	test("fails on an existing tag at another commit without creating", async () => {
		const api = fakeApi("bbb");
		await expect(createTag(api, "v1.0.0-rigel.1", "aaa")).rejects.toThrow("already exists at bbb");
		expect(api.created).toEqual([]);
	});
});
