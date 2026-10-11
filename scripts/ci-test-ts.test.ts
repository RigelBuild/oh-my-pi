import { describe, expect, test } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";

// ci-test-ts.ts runs on import, so exercise it as a subprocess in dry-run mode.
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
