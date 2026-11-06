import { expect, test } from "bun:test";

for (const debug of ["0", "1"])
	test(`Codex lifecycle stays secret-safe with debug=${debug} before provider import`, async () => {
		const child = Bun.spawn([process.execPath, "test", "./codex-debug.fixture.ts"], {
			cwd: import.meta.dir,
			env: { ...process.env, PI_CODEX_DEBUG: debug, OMP_LOG_LEVEL: "error" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
	});
