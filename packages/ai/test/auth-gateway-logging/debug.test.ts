import { expect, test } from "bun:test";

test("Codex debug lifecycle stays secret-safe when enabled before provider import", async () => {
	const child = Bun.spawn([process.execPath, "test", "./codex-debug.fixture.ts"], {
		cwd: import.meta.dir,
		env: { ...process.env, PI_CODEX_DEBUG: "1", OMP_LOG_LEVEL: "error" },
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
