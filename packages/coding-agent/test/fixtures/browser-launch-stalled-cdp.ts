import * as fs from "node:fs/promises";
import { createReadStream, writeSync } from "node:fs";

const pidFile = process.env.OMP_BROWSER_STALLED_PID_FILE;
if (!pidFile) throw new Error("OMP_BROWSER_STALLED_PID_FILE is required");
// "ack" answers CDP commands but never exits or opens a page; "ack-no-close" also leaves Browser.close unanswered.
// "no-upgrade" accepts the TCP connection but never answers the WebSocket upgrade.
const mode = process.env.OMP_BROWSER_STALLED_MODE;
const ackCommands = mode === "ack" || mode === "ack-no-close";

// Chromium's debugging pipe reads commands from fd 3 and writes responses to fd 4.
if (process.argv.includes("--remote-debugging-pipe")) {
	let pending = "";
	createReadStream("", { fd: 3 }).on("data", chunk => {
		pending += chunk.toString();
		let end = pending.indexOf("\0");
		while (end !== -1) {
			const command = pending.slice(0, end);
			pending = pending.slice(end + 1);
			if (ackCommands) {
				const { id, method, sessionId } = JSON.parse(command) as {
					id: number;
					method: string;
					sessionId?: string;
				};
				if (mode !== "ack-no-close" || method !== "Browser.close") {
					writeSync(4, `${JSON.stringify({ id, sessionId, result: {} })}\0`);
				}
			}
			end = pending.indexOf("\0");
		}
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, server) {
		if (mode === "no-upgrade") return new Promise<Response>(() => {});
		if (server.upgrade(request)) return undefined;
		return new Response("Not found", { status: 404 });
	},
	websocket: {
		message(ws, data) {
			if (!ackCommands) return;
			const { id, method, sessionId } = JSON.parse(String(data)) as {
				id: number;
				method: string;
				sessionId?: string;
			};
			if (mode === "ack-no-close" && method === "Browser.close") return;
			ws.send(JSON.stringify({ id, sessionId, result: {} }));
		},
	},
});

if (process.argv.includes("--remote-debugging-pipe")) {
	const userDataDir = process.argv.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
	if (!userDataDir) throw new Error("Missing Chromium profile directory");
	await fs.writeFile(`${userDataDir}/DevToolsActivePort`, `${server.port}\n/devtools/browser/fake\n`);
}

// Rename so a watcher never observes the PID file before its content lands.
await fs.writeFile(`${pidFile}.tmp`, String(process.pid));
await fs.rename(`${pidFile}.tmp`, pidFile);
process.stderr.write(`\nDevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/fake\n`);
