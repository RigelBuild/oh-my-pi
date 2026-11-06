import { expect, onTestFinished, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export const secret = {
	inbound: "SENTINEL_INBOUND_AUTH_8449",
	apiA: "SENTINEL_API_A_8449",
	apiB: "SENTINEL_API_B_8449",
	access: "sk-ant-oat-SENTINEL_ACCESS_8449",
	refresh: "SENTINEL_REFRESH_8449",
	request: "SENTINEL_REQUEST_BODY_8449",
	response: "SENTINEL_RESPONSE_BODY_8449",
	header: "SENTINEL_PRIVATE_HEADER_8449",
	error: "SENTINEL_ERROR_MESSAGE_8449",
	stack: "SENTINEL_ERROR_STACK_8449",
	cause: "SENTINEL_ERROR_CAUSE_8449",
	raw: "SENTINEL_CODEX_RAW_8449",
	captured: "SENTINEL_CAPTURED_BODY_8449",
	metadata: "SENTINEL_METADATA_8449",
};

const allowed: Record<string, true> = {
	requestId: true,
	pool: true,
	format: true,
	provider: true,
	model: true,
	credentialId: true,
	status: true,
	stage: true,
	window: true,
	retryAfterMs: true,
	durationMs: true,
	resetAtMs: true,
	usedPercent: true,
	limit: true,
	remaining: true,
};
function inspect(value: unknown, additionalSecrets: readonly string[] = []): void {
	if (typeof value === "string") {
		for (const sentinel of Object.values(secret)) expect(value).not.toContain(sentinel);
		for (const sentinel of additionalSecrets) expect(value).not.toContain(sentinel);
		return;
	}
	if (value === null || typeof value !== "object") return;
	// Inspect non-enumerable Error fields before serialization; the real logger exports them.
	for (const key of Object.getOwnPropertyNames(value)) inspect(Reflect.get(value, key), additionalSecrets);
}

export async function captureLogs() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-log-safety-"));
	const previousLevel = process.env.OMP_LOG_LEVEL;
	process.env.OMP_LOG_LEVEL = "debug";
	logger.setTransports({ file: directory });
	const args: unknown[][] = [];
	const spies = (["debug", "info", "warn", "error"] as const).map(level => {
		const original = logger[level];
		return spyOn(logger, level).mockImplementation((message, context) => {
			args.push([message, context]);
			original(message, context);
		});
	});
	const events: logger.LogEvent[] = [];
	const secondSink: logger.LogEvent[] = [];
	const dispose = logger.registerLogSink(event => events.push(event));
	const disposeSecond = logger.registerLogSink(event => secondSink.push(event));
	let cleanup: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (cleanup) return cleanup;
		dispose();
		disposeSecond();
		for (const spy of spies) spy.mockRestore();
		if (previousLevel === undefined) delete process.env.OMP_LOG_LEVEL;
		else process.env.OMP_LOG_LEVEL = previousLevel;
		logger.setTransports({ file: true });
		cleanup = fs.rm(directory, { recursive: true, force: true });
		return cleanup;
	};
	// A runner timeout does not unwind the test's pending async finally block.
	onTestFinished(close);
	return {
		events,
		matching: (message: string) => events.filter(event => event.message === message),
		async assertSafe(additionalSecrets: readonly string[] = []) {
			expect(events.length).toBeGreaterThan(0);
			expect(args.length).toBe(events.length);
			expect(secondSink).toEqual(events);
			inspect(args, additionalSecrets);
			for (const event of events) {
				inspect(event.message, additionalSecrets);
				inspect(event.context, additionalSecrets);
				if (
					!/^auth-gateway (credential selected|provider response|quota observation|provider attempt failed|request failed|usage-limit recovery failed)$/.test(
						event.message,
					)
				)
					continue;
				expect(event.context).toBeDefined();
				for (const key of ["requestId", "pool", "format", "provider", "model"])
					expect(typeof event.context?.[key]).toBe("string");
				for (const [key, value] of Object.entries(event.context ?? {})) {
					expect(["string", "number"]).toContain(typeof value);
					expect(Object.hasOwn(allowed, key)).toBe(true);
					if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
				}
			}
			logger.flush();
			const files = await fs.readdir(directory);
			expect(files.length).toBeGreaterThan(0);
			const output = (await Promise.all(files.map(file => fs.readFile(path.join(directory, file), "utf8")))).join(
				"",
			);
			expect(output).toContain("auth-gateway");
			inspect(output, additionalSecrets);
		},
		close,
	};
}
