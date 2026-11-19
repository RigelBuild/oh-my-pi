import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Shell } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

let sharedTempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedTempDir = TempDir.createSync("@rig11249-shared-");
	authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
	sharedTempDir.removeSync();
});

afterEach(() => {
	mock.restore();
});

describe("BashTool original-output artifact redaction", () => {
	it("writes the minimized original with the extension-registered secret redacted", async () => {
		const secret = "rig11249-registered-secret-value";
		const rawOutput = `deploy token=${secret}\n`.repeat(40);
		const minimizedText = "deploy: 40 lines summarized\n";
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, _options, onChunk) {
			onChunk?.(null, rawOutput);
			return Promise.resolve({
				exitCode: 1,
				cancelled: false,
				timedOut: false,
				workingDir: process.cwd(),
				minimized: {
					filter: "deploy",
					text: minimizedText,
					originalText: rawOutput,
					inputBytes: Buffer.byteLength(rawOutput, "utf-8"),
					outputBytes: Buffer.byteLength(minimizedText, "utf-8"),
				},
			});
		});

		// A real extension registers the artifact_text handler through the extension loader,
		// the same way secret-redact registers tool_result.
		const tempDir = TempDir.createSync("@rig11249-ext-");
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-original-redaction-"));
		try {
			const extPath = path.join(tempDir.path(), "redact.ts");
			await Bun.write(
				extPath,
				`export default function (pi) {
					pi.on("artifact_text", event => ({
						text: event.text.split(${JSON.stringify(secret)}).join("[REDACTED:TOKEN]"),
					}));
				}`,
			);
			const loaded = await loadExtensions([extPath], tempDir.path());
			const sessionManager = SessionManager.inMemory();
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Sequential ids like the session's spill manager: the sink spill gets 1, the raw original 2.
			let nextId = 1;
			const session = {
				cwd: tempDir.path(),
				hasUI: false,
				skills: [],
				getSessionFile: () => null,
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bash.autoBackground.thresholdMs": 60_000,
					"bashInterceptor.enabled": false,
					"astGrep.enabled": false,
					"astEdit.enabled": false,
					"grep.enabled": false,
					"glob.enabled": false,
				}),
				getClientBridge: () => undefined,
				allocateOutputArtifact: async () => {
					const id = String(nextId++);
					return { id, path: path.join(artifactsDir, `${id}.log`) };
				},
				redactArtifactText: (text: string) => runner.redactArtifactText(text),
			} as unknown as ToolSession;

			const result = await new BashTool(session).execute("call-original-redaction", { command: "deploy" });

			expect(result.details?.meta?.minimized?.artifactId).toBe("2");
			const written = await Bun.file(path.join(artifactsDir, "2.log")).text();
			expect(written).not.toContain(secret);
			expect(written).toContain("[REDACTED:TOKEN]");
		} finally {
			await fs.rm(artifactsDir, { recursive: true, force: true });
			tempDir.removeSync();
		}
	});
});
