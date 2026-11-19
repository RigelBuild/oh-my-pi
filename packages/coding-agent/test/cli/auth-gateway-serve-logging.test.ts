import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const FIXTURE = path.join(import.meta.dir, "fixtures", "gateway-serve-logging-child.ts");
const PROBE = "gateway-serve-logging-probe";

describe("auth-gateway serve logging", () => {
	test("serve routes info logs to stdout and writes no log file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-serve-logging-"));
		try {
			const home = path.join(root, "home");
			const tmp = path.join(root, "tmp");
			await Promise.all([fs.mkdir(home), fs.mkdir(tmp)]);
			const proc = Bun.spawn([process.execPath, FIXTURE], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					PI_CONFIG_DIR: ".omp",
					OMP_PROFILE: "",
					PI_PROFILE: "",
					XDG_DATA_HOME: "",
					XDG_STATE_HOME: "",
					XDG_CACHE_HOME: "",
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
					TMPDIR: tmp,
					TMP: tmp,
					TEMP: tmp,
					PI_TEST_RUNTIME: "",
					OMP_LOG_LEVEL: "",
					TZ: "Etc/GMT+5",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);

			// Console transport: the record is written to stdout as a log line.
			expect(stdout).toContain(PROBE);

			// File transport off: no rotating log file is created under the config root.
			const logsDir = path.join(home, ".omp", "logs");
			const logFiles = await fs.readdir(logsDir).catch(() => [] as string[]);
			expect(logFiles.filter(name => name.startsWith("omp"))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
