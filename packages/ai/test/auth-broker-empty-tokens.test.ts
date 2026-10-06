import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { isLoopbackHost } from "../src/utils/parse-bind";
import { removeWithRetries } from "../../utils/src/temp";

describe("isLoopbackHost", () => {
	test.each(["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "[::1]", "localhost", "LOCALHOST"])(
		"%s is loopback",
		host => {
			expect(isLoopbackHost(host)).toBe(true);
		},
	);

	test.each([
		"0.0.0.0",
		"::",
		"[::]",
		"10.0.0.1",
		"128.0.0.1",
		"127.0.0.256",
		"127.1",
		"broker.internal",
		"localhost.evil",
		"",
	])("%s is not loopback", host => {
		expect(isLoopbackHost(host)).toBe(false);
	});
});

describe("auth-broker with an empty token set", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	async function start(bind: string): Promise<AuthBrokerServerHandle> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-empty-tokens-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		handle = startAuthBroker({ storage, bind, bearerTokens: [], disableRefresher: true });
		return handle;
	}

	afterEach(async () => {
		await handle?.close();
		storage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
		handle = undefined;
		storage = undefined;
		store = undefined;
		tempDir = "";
	});

	test("loopback bind serves vault routes without a bearer", async () => {
		const broker = await start("127.0.0.1:0");
		const res = await fetch(`http://127.0.0.1:${broker.port}/v1/snapshot`);
		expect(res.status).toBe(200);
	});

	test("non-loopback bind refuses vault routes, with or without a bearer", async () => {
		const broker = await start("0.0.0.0:0");
		const bare = await fetch(`http://127.0.0.1:${broker.port}/v1/snapshot`);
		expect(bare.status).toBe(401);
		const withBearer = await fetch(`http://127.0.0.1:${broker.port}/v1/snapshot`, {
			headers: { Authorization: "Bearer anything" },
		});
		expect(withBearer.status).toBe(401);
	});

	test("non-loopback bind still serves healthz", async () => {
		const broker = await start("0.0.0.0:0");
		const res = await fetch(`http://127.0.0.1:${broker.port}/v1/healthz`);
		expect(res.status).toBe(200);
	});
});
