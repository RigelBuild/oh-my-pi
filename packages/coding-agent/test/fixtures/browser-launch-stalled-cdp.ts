import * as fs from "node:fs/promises";

const pidFile = process.env.OMP_BROWSER_STALLED_PID_FILE;
if (!pidFile) throw new Error("OMP_BROWSER_STALLED_PID_FILE is required");

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, server) {
		if (server.upgrade(request)) return undefined;
		return new Response("Not found", { status: 404 });
	},
	websocket: {
		message() {},
	},
});

await fs.writeFile(pidFile, String(process.pid));
process.stderr.write(`\nDevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/fake\n`);
