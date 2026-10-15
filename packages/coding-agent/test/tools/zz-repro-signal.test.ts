import { expect, it } from "bun:test";
import { acquireBrowser } from "../../src/tools/browser/registry";

it("shared browser survives abort of the open that launched it", async () => {
	const ac = new AbortController();
	const h = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd(), signal: ac.signal, timeoutMs: 30_000 });
	expect(h.browser.connected).toBe(true);
	ac.abort(new Error("caller cancelled after launch"));
	await Bun.sleep(1_500);
	console.log("connected after abort:", h.browser.connected, "pid alive:", h.browser.process()?.exitCode === null);
	expect(h.browser.connected).toBe(true);
}, 60_000);
