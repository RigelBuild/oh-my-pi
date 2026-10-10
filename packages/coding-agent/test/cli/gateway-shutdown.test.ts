import { expect, test } from "bun:test";
import * as path from "node:path";

const FIXTURE = path.join(import.meta.dir, "fixtures", "gateway-shutdown-child.ts");

async function readUntil(chunks: AsyncIterator<Uint8Array>, pattern: RegExp, seen: { text: string }) {
	const decoder = new TextDecoder();
	while (!pattern.test(seen.text)) {
		const { value, done } = await chunks.next();
		if (done) throw new Error(`child stdout closed before ${pattern}: ${seen.text}`);
		seen.text += decoder.decode(value, { stream: true });
	}
	return seen.text.match(pattern)!;
}

async function sigtermDuringHeldResponse(holdMs: number, drainMs: number) {
	const child = Bun.spawn([process.execPath, FIXTURE], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOLD_MS: String(holdMs), DRAIN_MS: String(drainMs) },
	});
	try {
		const reader = child.stdout[Symbol.asyncIterator]();
		const seen = { text: "" };
		const [, url, model] = await readUntil(reader, /URL (\S+) MODEL (\S+)\n/, seen);
		const response = fetch(`${url}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
		}).then(
			async res => ({ status: res.status, body: await res.text() }),
			() => null,
		);
		await readUntil(reader, /ACTIVE\n/, seen);
		const signalledAt = performance.now();
		child.kill("SIGTERM");

		const result = await response;
		const exitCode = await child.exited;
		return { result, exitCode, elapsedMs: performance.now() - signalledAt };
	} finally {
		child.kill("SIGKILL");
	}
}

// Past the 10 s default postmortem deadline, so a second SIGTERM owner would cut it off.
test("SIGTERM drains a held response past 10 s, then exits 143", async () => {
	const { result, exitCode, elapsedMs } = await sigtermDuringHeldResponse(12_000, 20_000);
	expect(result?.status).toBe(200);
	expect(result?.body).toContain("held response completed");
	expect(exitCode).toBe(143);
	expect(elapsedMs).toBeGreaterThan(10_000);
}, 30_000);

test("SIGTERM force-stops a response that outlasts the drain, then exits 143", async () => {
	const { result, exitCode, elapsedMs } = await sigtermDuringHeldResponse(20_000, 1_000);
	expect(result?.body ?? "").not.toContain("held response completed");
	expect(exitCode).toBe(143);
	expect(elapsedMs).toBeLessThan(10_000);
}, 30_000);
