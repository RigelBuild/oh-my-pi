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

// Past the 10 s default postmortem deadline, so a second SIGTERM owner would cut it off.
test("SIGTERM drains a held response past 10 s, then exits 143", async () => {
	const child = Bun.spawn([process.execPath, FIXTURE], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOLD_MS: "12000", DRAIN_MS: "20000" },
	});
	try {
		const reader = child.stdout[Symbol.asyncIterator]();
		const seen = { text: "" };
		const [, url, model] = await readUntil(reader, /URL (\S+) MODEL (\S+)\n/, seen);
		const response = fetch(`${url}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
		});
		await readUntil(reader, /ACTIVE\n/, seen);
		const signalledAt = performance.now();
		child.kill("SIGTERM");

		const result = await response;
		expect(result.status).toBe(200);
		expect(await result.text()).toContain("held response completed");
		expect(await child.exited).toBe(143);
		expect(performance.now() - signalledAt).toBeGreaterThan(10_000);
	} finally {
		child.kill("SIGKILL");
	}
}, 30_000);
