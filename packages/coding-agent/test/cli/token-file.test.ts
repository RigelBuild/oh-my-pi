import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { ensureTokenFile, readTokenFile, writeTokenFile } from "../../src/cli/token-file";

let dir = "";

afterEach(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = "";
});

async function tokenPath(): Promise<string> {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-token-file-"));
	return path.join(dir, "nested", "metrics.token");
}

async function mintInProcesses(file: string, count: number): Promise<string[]> {
	const helper = path.join(import.meta.dir, "../../src/cli/token-file.ts");
	// Each child imports the helper by path: a separate process is the race being tested.
	const script = `const { ensureTokenFile } = await import(${JSON.stringify(helper)}); process.stdout.write(await ensureTokenFile(${JSON.stringify(file)}));`;
	const procs = Array.from({ length: count }, () =>
		Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env } }),
	);
	return Promise.all(
		procs.map(async proc => {
			const out = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			return out;
		}),
	);
}

test.each([
	["no file", false],
	["a blank file", true],
])("concurrent first mints in separate processes from %s return the persisted token", async (_label, blank) => {
	const file = await tokenPath();
	if (blank) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "\n");
	}
	const tokens = await mintInProcesses(file, 8);
	const persisted = await Bun.file(file).text();
	expect(persisted).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(new Set(tokens)).toEqual(new Set([persisted]));
});

test("concurrent first mints in one process all return the persisted token", async () => {
	const file = await tokenPath();
	const tokens = await Promise.all(Array.from({ length: 16 }, () => ensureTokenFile(file)));
	expect(new Set(tokens)).toEqual(new Set([await Bun.file(file).text()]));
});

test("replaces a blank token file and keeps 0600", async () => {
	const file = await tokenPath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "  \n");
	const token = await ensureTokenFile(file);
	expect(await Bun.file(file).text()).toBe(token);
	expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	expect(await ensureTokenFile(file)).toBe(token);
});

test("rotation holds the lock and readers keep the old token until publication", async () => {
	const file = await tokenPath();
	await writeTokenFile(file, "old-token");
	const realWrite = fs.writeFile;
	const { promise: staged, resolve: markStaged } = Promise.withResolvers<void>();
	const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
	const write = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
		await realWrite(target, String(data).slice(0, 3), options);
		markStaged();
		await gate;
		await realWrite(target, data, options);
	});
	try {
		const rotation = writeTokenFile(file, "new-token");
		await staged;
		expect(await readTokenFile(file)).toBe("old-token");
		expect(tryAcquireFileLock(file)).toBeNull();
		openGate();
		await rotation;
	} finally {
		write.mockRestore();
	}
	expect(await readTokenFile(file)).toBe("new-token");
});

test("a failed publish keeps the old token and removes the staged file", async () => {
	const file = await tokenPath();
	await writeTokenFile(file, "old-token");
	const rename = spyOn(fsp, "rename").mockRejectedValueOnce(Object.assign(new Error("io"), { code: "EIO" }));
	try {
		await expect(writeTokenFile(file, "new-token")).rejects.toThrow("io");
	} finally {
		rename.mockRestore();
	}
	expect(await readTokenFile(file)).toBe("old-token");
	expect(await fs.readdir(path.dirname(file))).toEqual(["metrics.token"]);
});
