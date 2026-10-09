import { describe, expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { selectShard, splitIntoChunks } from "./ci-test-ts";

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("omp-test-runner-watchdog-");
		const started = dir.join("started");
		const completed = dir.join("completed");
		const continued = dir.join("continued");
		const stalledCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(completed)}, "completed");`,
		];
		const nextCommand = [process.execPath, "-e", `await Bun.write(${JSON.stringify(continued)}, "continued");`];
		const commands = [
			{ label: "stalled chunk", cwd: ".", command: stalledCommand },
			{ label: "following chunk", cwd: ".", command: nextCommand },
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel(${JSON.stringify(commands)}, 1);`,
			],
			{
				env: { ...Bun.env, OMP_TEST_CHUNK_TIMEOUT: "1", NO_COLOR: "1" },
				timeout: 10_000,
				detached: true,
				allowNonZero: true,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("[watchdog]");
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});

describe("OMP_TEST_SHARD", () => {
	test("shards partition every chunk exactly once, balanced to within one", () => {
		const chunks = Array.from({ length: 79 }, (_, i) => i);
		const shards = [1, 2, 3].map(i => selectShard(chunks, `${i}/3`));
		expect(shards.flat().sort((a, b) => a - b)).toEqual(chunks);
		const sizes = shards.map(s => s.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
		expect(selectShard(chunks, "1/1")).toEqual(chunks);
		expect(selectShard(chunks, undefined)).toEqual(chunks);
	});

	test("rejects malformed specs instead of running an empty or partial shard", () => {
		for (const spec of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) {
			expect(() => selectShard([1, 2, 3], spec)).toThrow("Invalid OMP_TEST_SHARD");
		}
	});

	test("rejects a shard that selects no chunks", () => {
		expect(() => selectShard([1], "2/2")).toThrow("selects no chunks");
		expect(() => selectShard([], "1/1")).toThrow("selects no chunks");
	});
});

describe("splitIntoChunks", () => {
	test("keeps every file once, in order, with sizes within one", () => {
		const files = Array.from({ length: 483 }, (_, i) => `test/${String(i).padStart(3, "0")}.test.ts`);
		const chunks = splitIntoChunks(files, 4);
		expect(chunks).toHaveLength(4);
		expect(chunks.flat()).toEqual(files);
		const sizes = chunks.map(c => c.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
	});

	test("never emits an empty chunk, which bun test would run as the whole package", () => {
		expect(splitIntoChunks(["a", "b"], 4)).toEqual([["a"], ["b"]]);
		expect(splitIntoChunks([], 4)).toEqual([]);
	});

	test("rejects a chunk count that is not a positive integer", () => {
		for (const count of [0, -1, 1.5, Number.NaN]) {
			expect(() => splitIntoChunks(["a"], count)).toThrow("Invalid chunk count");
		}
	});
});

describe("packages/ai chunking", () => {
	test.each(["workspace", "local-ts"])(
		"%s mode runs packages/ai as 4 commands covering every ai test file once",
		async mode => {
			const result = await ptree.exec([process.execPath, `${import.meta.dir}/ci-test-ts.ts`, mode, "--dry-run"], {
				env: { ...Bun.env, CI: "true", NO_COLOR: "1" },
				timeout: 30_000,
			});
			const lines = result.stdout.split("\n");
			const aiCommands = lines.flatMap((line, i) =>
				line.startsWith("==> packages/ai (chunk ") ? [lines[i + 1]] : [],
			);
			expect(aiCommands).toHaveLength(4);
			const listed = aiCommands.flatMap(line => line.split(" ").filter(arg => arg.endsWith(".test.ts")));
			const onDisk = await Array.fromAsync(
				new Bun.Glob("test/**/*.test.ts").scan({ cwd: `${import.meta.dir}/../packages/ai` }),
			);
			expect(listed.sort()).toEqual(onDisk.sort());
		},
	);
});
