import * as fs from "node:fs/promises";

const pidFile = process.env.OMP_BROWSER_STALLED_PID_FILE;
if (!pidFile) throw new Error("OMP_BROWSER_STALLED_PID_FILE is required");
// "ack" answers CDP commands but never exits or opens a page; "ack-no-close" also leaves Browser.close unanswered.
// "no-upgrade" accepts the TCP connection but never answers the WebSocket upgrade.
const mode = process.env.OMP_BROWSER_STALLED_MODE;
const ackCommands = mode === "ack" || mode === "ack-no-close";

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

// Rename so a watcher never observes the PID file before its content lands.
await fs.writeFile(`${pidFile}.tmp`, String(process.pid));
await fs.rename(`${pidFile}.tmp`, pidFile);
process.stderr.write(`\nDevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/fake\n`);
