import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { GATEWAY_MODEL_KINDS } from "../../src/cli/auth-gateway-cli";
import { buildGatewayCatalog, getGatewayBootConfig, readTokenFile, runGatewayBoot } from "../../src/cli/gateway-boot";

type GatewayReady = { kind: "read"; value: Uint8Array | undefined; done: boolean } | { kind: "exit"; code: number };

const FIXTURE = path.join(import.meta.dir, "fixtures", "gateway-boot-child.ts");
const SERVICE_TOKEN = "service-test-token";
const GOOD_AGENT_TOKEN = "agent-test-token";
const INTERNAL_AGENT_TOKEN = "internal-test-token";
const BAD_AGENT_TOKEN = "bad-agent-token";
const TEST_CERT_FIXTURE = path.join(import.meta.dir, "fixtures", "compass-ca.crt");
const TEST_KEY_FIXTURE = path.join(import.meta.dir, "fixtures", "compass-ca.key");
const WRONG_CA_FIXTURE = path.join(import.meta.dir, "fixtures", "wrong-ca.crt");
const TEST_CERT = await Bun.file(TEST_CERT_FIXTURE).text();
const TEST_KEY = await Bun.file(TEST_KEY_FIXTURE).text();

let servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers) server.stop(true);
	servers = [];
});
function reserveBind(): { bind: string; url: string } {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const bind = `127.0.0.1:${server.port}`;
	server.stop(true);
	return { bind, url: `http://${bind}` };
}

function expectBindAvailable(bind: string): void {
	const [, port] = bind.split(":");
	if (!port) throw new Error("expected a host and port");
	const server = Bun.serve({ hostname: "127.0.0.1", port: Number(port), fetch: () => new Response() });
	server.stop(true);
}

async function expectRejectedBeforeBind(
	env: Readonly<Record<string, string | undefined>>,
	message: string,
): Promise<void> {
	const { bind } = reserveBind();
	await expect(runGatewayBoot({ ...env, COMPASS_GATEWAY_BIND: bind })).rejects.toThrow(message);
	expectBindAvailable(bind);
}

async function startGateway(
	childEnv: Readonly<Record<string, string | undefined>>,
	url: string,
): Promise<Bun.Subprocess> {
	const child = Bun.spawn([process.execPath, FIXTURE], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...childEnv },
	});
	const output = child.stdout;
	if (!output) throw new Error("gateway process stdout is unavailable");
	const reader = output.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes("READY\n")) {
		const next = reader.read().then(({ value, done }): GatewayReady => ({ kind: "read", value, done }));
		const exit = child.exited.then((code): GatewayReady => ({ kind: "exit", code }));
		const result = await Promise.race([next, exit]);
		if (result.kind === "exit") throw new Error(`gateway process exited with code ${result.code}`);
		if (result.done) throw new Error("gateway process closed stdout before readiness");
		text += decoder.decode(result.value, { stream: true });
	}
	reader.releaseLock();
	const response = await fetch(`${url}/healthz`);
	expect(response.status).toBe(200);
	return child;
}

type FakeCompassOptions = {
	tls?: { cert: string; key: string };
	stableModel?: { provider: string; modelId: string };
	registryUnavailable?: boolean;
};

const LISTED_STABLE_NAME = "stable-anthropic-chat";
const FIRST_KNOWN_STABLE_NAME = "first-known-anthropic-chat";

function startFakeCompass(options: FakeCompassOptions = {}): Bun.Server<undefined> {
	const entries =
		options.stableModel === undefined
			? {}
			: {
					[LISTED_STABLE_NAME]: {
						candidates: [options.stableModel],
					},
					[FIRST_KNOWN_STABLE_NAME]: {
						candidates: [{ provider: "missing", modelId: "gone" }, options.stableModel],
					},
				};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		...(options.tls === undefined ? {} : { tls: options.tls }),
		async fetch(request) {
			const url = new URL(request.url);
			const body: unknown = await request.json();
			if (
				request.headers.get("authorization") !== `Bearer ${SERVICE_TOKEN}` ||
				request.headers.get("connect-protocol-version") !== "1" ||
				request.headers.get("content-type") !== "application/json"
			) {
				return Response.json({ code: "unauthenticated", message: "unauthenticated" }, { status: 401 });
			}
			if (
				url.pathname === "/compass.v1.GatewayRegistry/GetGatewayModelRegistryVersion" ||
				url.pathname === "/compass.v1.GatewayRegistry/GetGatewayModelRegistry"
			) {
				if (options.registryUnavailable) {
					return Response.json({ code: "unavailable", message: "registry unavailable" }, { status: 503 });
				}
				if (url.pathname.endsWith("GetGatewayModelRegistryVersion")) return Response.json({ version: "1" });
				return Response.json({ version: "1", registry: { entries } });
			}
			if (url.pathname === "/compass.v1.GatewayAuth/VerifyAgentToken") {
				if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
					return Response.json({ code: "invalid_argument", message: "invalid token" }, { status: 400 });
				}
				if (body.token === "") {
					return Response.json({ code: "unauthenticated", message: "invalid agent token" }, { status: 401 });
				}
				if (body.token === GOOD_AGENT_TOKEN) {
					return Response.json({ agentAccountId: "agent-1", ownerUserId: "owner-1" });
				}
				if (body.token === INTERNAL_AGENT_TOKEN) {
					return Response.json({ code: "internal", message: "verification unavailable" }, { status: 500 });
				}
				return Response.json({ code: "unauthenticated", message: "invalid agent token" }, { status: 401 });
			}
			if (url.pathname === "/compass.v1.GatewayCredentials/ListCredentialPool") {
				if (
					typeof body !== "object" ||
					body === null ||
					!("agentToken" in body) ||
					body.agentToken !== GOOD_AGENT_TOKEN
				) {
					return Response.json({ code: "unauthenticated", message: "invalid agent token" }, { status: 401 });
				}
				return Response.json({ credentials: [] });
			}
			return Response.json({ code: "unimplemented", message: "unknown method" }, { status: 404 });
		},
	});
	servers.push(server);
	return server;
}

describe("Compass gateway boot", () => {
	test("requires a valid Compass server URL before binding", async () => {
		await expectRejectedBeforeBind({}, "COMPASS_SERVER_URL is required");
		await expectRejectedBeforeBind({ COMPASS_SERVER_URL: "http://compass.example" }, "COMPASS_SERVER_URL is invalid");
		await expectRejectedBeforeBind({ COMPASS_SERVER_URL: "not a url" }, "COMPASS_SERVER_URL is invalid");
	});

	test("requires readable CA material for HTTPS before binding", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		await expectRejectedBeforeBind(
			{
				COMPASS_SERVER_URL: "https://localhost:8443",
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
			},
			"COMPASS_SERVER_CA_FILE",
		);
		await expectRejectedBeforeBind(
			{
				COMPASS_SERVER_URL: "https://localhost:8443",
				COMPASS_SERVER_CA_FILE: "/path/that/does/not/exist",
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
			},
			"COMPASS_SERVER_CA_FILE",
		);
	});

	test("reports unreadable and empty service-token files by environment name", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const emptyFile = dir.join("empty-service-token");
		await Bun.write(emptyFile, " \n");
		const { bind } = reserveBind();
		const common = { COMPASS_SERVER_URL: "http://127.0.0.1:4100", COMPASS_GATEWAY_BIND: bind };
		await expect(runGatewayBoot({ ...common, COMPASS_SERVICE_TOKEN_FILE: dir.join("missing") })).rejects.toThrow(
			"COMPASS_SERVICE_TOKEN_FILE",
		);
		await expect(runGatewayBoot({ ...common, COMPASS_SERVICE_TOKEN_FILE: emptyFile })).rejects.toThrow(
			"COMPASS_SERVICE_TOKEN_FILE",
		);
		expectBindAvailable(bind);
	});

	test("rejects an invalid enrollment-token file before binding", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		const enrollFile = dir.join("enroll-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		await Bun.write(enrollFile, "\n ");
		await expectRejectedBeforeBind(
			{
				COMPASS_SERVER_URL: "http://127.0.0.1:4100",
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
				COMPASS_GATEWAY_ENROLL_TOKEN_FILE: enrollFile,
			},
			"COMPASS_GATEWAY_ENROLL_TOKEN_FILE",
		);
	});
	test("accepts a valid enrollment token file", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		const enrollFile = dir.join("enroll-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		await Bun.write(enrollFile, "enroll-secret\n");
		expect(await readTokenFile(enrollFile, "COMPASS_GATEWAY_ENROLL_TOKEN_FILE")).toBe("enroll-secret");
		expect(
			getGatewayBootConfig({
				COMPASS_SERVER_URL: "http://127.0.0.1:4100",
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
				COMPASS_GATEWAY_ENROLL_TOKEN_FILE: enrollFile,
			}).enrollTokenFile,
		).toBe(enrollFile);
	});

	test("fails the door probe before binding", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ code: "internal", message: "probe failed" }, { status: 500 }),
		});
		servers.push(server);
		await expectRejectedBeforeBind(
			{
				COMPASS_SERVER_URL: server.url.toString(),
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
			},
			"Compass agent verification failed",
		);
	});

	test("reads one token and uses stack environment defaults", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const tokenFile = dir.join("service-token");
		await Bun.write(tokenFile, `${SERVICE_TOKEN}\n`);
		expect(await readTokenFile(tokenFile, "COMPASS_SERVICE_TOKEN_FILE")).toBe(SERVICE_TOKEN);
		expect(getGatewayBootConfig({ COMPASS_SERVER_URL: "http://127.0.0.1:4100" })).toEqual({
			serviceTokenFile: "/run/compass/service.token",
			serverUrl: "http://127.0.0.1:4100",
			caFile: undefined,
			bind: "0.0.0.0:4000",
			drainMs: 20000,
			enrollTokenFile: undefined,
		});
		expect(
			getGatewayBootConfig({
				COMPASS_SERVER_URL: "https://localhost:8443/",
				COMPASS_SERVER_CA_FILE: "/run/compass/server-ca.crt",
				COMPASS_SERVICE_TOKEN_FILE: "/run/secrets/service",
				COMPASS_GATEWAY_ENROLL_TOKEN_FILE: "/run/secrets/enroll",
				COMPASS_GATEWAY_BIND: "127.0.0.1:4000",
				COMPASS_GATEWAY_DRAIN_MS: "15000",
			}),
		).toEqual({
			serviceTokenFile: "/run/secrets/service",
			serverUrl: "https://localhost:8443",
			caFile: "/run/compass/server-ca.crt",
			bind: "127.0.0.1:4000",
			drainMs: 15000,
			enrollTokenFile: "/run/secrets/enroll",
		});
	});

	test("rejects invalid drain deadlines and empty bind configuration", () => {
		expect(() =>
			getGatewayBootConfig({ COMPASS_SERVER_URL: "http://localhost", COMPASS_GATEWAY_DRAIN_MS: "20s" }),
		).toThrow("COMPASS_GATEWAY_DRAIN_MS must be a positive integer");
		expect(() =>
			getGatewayBootConfig({ COMPASS_SERVER_URL: "http://localhost", COMPASS_GATEWAY_DRAIN_MS: "2147481648" }),
		).toThrow("COMPASS_GATEWAY_DRAIN_MS must be a positive integer no greater than 2147481647");
		expect(
			getGatewayBootConfig({ COMPASS_SERVER_URL: "http://localhost", COMPASS_GATEWAY_DRAIN_MS: "2147481647" })
				.drainMs,
		).toBe(2147481647);
		expect(() => getGatewayBootConfig({ COMPASS_SERVER_URL: "http://localhost", COMPASS_GATEWAY_BIND: "" })).toThrow(
			"COMPASS_GATEWAY_BIND must not be empty",
		);
	});

	test("catalog uses qualified ids and only gateway-routable kinds", () => {
		const catalog = buildGatewayCatalog();
		const models = Array.from(catalog.listModels());
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(modelKind(model)).toBeOneOf(GATEWAY_MODEL_KINDS);
			expect(catalog.resolveModel(`${model.provider}/${model.id}`)).toBe(model);
		}
		expect(catalog.resolveModel("abliterated-model")).toBeUndefined();
	});
	test("uses COMPASS_SERVER_CA_FILE for HTTPS verification and owner RPCs", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		const compass = startFakeCompass({ tls: { cert: TEST_CERT, key: TEST_KEY } });
		const gatewayBind = reserveBind();
		const env = {
			COMPASS_SERVER_URL: `https://127.0.0.1:${compass.port}`,
			COMPASS_SERVICE_TOKEN_FILE: serviceFile,
			COMPASS_SERVER_CA_FILE: TEST_CERT_FIXTURE,
			COMPASS_GATEWAY_BIND: gatewayBind.bind,
		};
		const child = await startGateway(env, gatewayBind.url);
		try {
			const listing = await fetch(`${gatewayBind.url}/v1/models`, {
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}` },
			});
			expect(listing.status).toBe(200);
			const model = Array.from(buildGatewayCatalog().listModels()).find(
				candidate => modelKind(candidate) === "chat",
			);
			if (!model) throw new Error("expected a bundled chat model");
			const noCredential = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: `${model.provider}/${model.id}`,
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			expect(noCredential.status).toBe(401);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}

		const { bind } = reserveBind();
		await expect(
			runGatewayBoot({ ...env, COMPASS_SERVER_CA_FILE: WRONG_CA_FIXTURE, COMPASS_GATEWAY_BIND: bind }),
		).rejects.toThrow("Compass agent verification failed");
		expectBindAvailable(bind);
	});
	test("keeps Compass HTTP traffic off the provider proxy", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		const compass = startFakeCompass();
		const gatewayBind = reserveBind();
		const env = {
			COMPASS_SERVER_URL: `http://[::ffff:127.0.0.1]:${compass.port}`,
			COMPASS_SERVICE_TOKEN_FILE: serviceFile,
			COMPASS_GATEWAY_BIND: gatewayBind.bind,
			PI_PROXY: "http://127.0.0.1:1",
		};
		const child = await startGateway(env, gatewayBind.url);
		try {
			const listing = await fetch(`${gatewayBind.url}/v1/models`, {
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}` },
			});
			expect(listing.status).toBe(200);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	test("serves stable names from the caller's model registry", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		const model = Array.from(buildGatewayCatalog().listModels()).find(
			candidate => candidate.provider === "anthropic" && modelKind(candidate) === "chat",
		);
		if (!model) throw new Error("expected a bundled Anthropic chat model");
		const compass = startFakeCompass({ stableModel: { provider: model.provider, modelId: model.id } });
		const gatewayBind = reserveBind();
		const child = await startGateway(
			{
				COMPASS_SERVER_URL: compass.url.toString(),
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
				COMPASS_GATEWAY_BIND: gatewayBind.bind,
			},
			gatewayBind.url,
		);
		try {
			const listed = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: LISTED_STABLE_NAME, messages: [{ role: "user", content: "hi" }] }),
			});
			expect(listed.status).toBe(401);

			const firstKnown = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: FIRST_KNOWN_STABLE_NAME, messages: [{ role: "user", content: "hi" }] }),
			});
			expect(firstKnown.status).toBe(401);

			const listing = await fetch(`${gatewayBind.url}/v1/models`, {
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}` },
			});
			expect(listing.status).toBe(200);
			const listedModels = await listing.text();
			expect(listedModels).toContain(LISTED_STABLE_NAME);
			expect(listedModels).not.toContain(FIRST_KNOWN_STABLE_NAME);

			const bare = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: "unregistered-model-id", messages: [{ role: "user", content: "hi" }] }),
			});
			expect(bare.status).toBe(404);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});

	test("keeps provider-qualified models available when the registry is unavailable", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		const compass = startFakeCompass({ registryUnavailable: true });
		const gatewayBind = reserveBind();
		const child = await startGateway(
			{
				COMPASS_SERVER_URL: compass.url.toString(),
				COMPASS_SERVICE_TOKEN_FILE: serviceFile,
				COMPASS_GATEWAY_BIND: gatewayBind.bind,
			},
			gatewayBind.url,
		);
		try {
			const model = Array.from(buildGatewayCatalog().listModels()).find(
				candidate => candidate.provider === "anthropic" && modelKind(candidate) === "chat",
			);
			if (!model) throw new Error("expected a bundled Anthropic chat model");
			const qualified = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: `${model.provider}/${model.id}`,
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			expect(qualified.status).toBe(401);
			expect((await fetch(`${gatewayBind.url}/healthz`)).status).toBe(200);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});
	test("serves Compass-backed authorization, model listing, and owner credential lookup", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const serviceFile = dir.join("service-token");
		await Bun.write(serviceFile, SERVICE_TOKEN);
		const compass = startFakeCompass();
		const gatewayBind = reserveBind();
		const env = {
			COMPASS_SERVER_URL: compass.url.toString(),
			COMPASS_SERVICE_TOKEN_FILE: serviceFile,
			COMPASS_GATEWAY_BIND: gatewayBind.bind,
		};
		const child = await startGateway(env, gatewayBind.url);
		try {
			const health = await fetch(`${gatewayBind.url}/healthz`);
			expect(health.status).toBe(200);

			const models = Array.from(buildGatewayCatalog().listModels());
			const model = models.find(candidate => candidate.provider === "anthropic" && modelKind(candidate) === "chat");
			if (!model) throw new Error("expected a bundled Anthropic chat model");

			const listing = await fetch(`${gatewayBind.url}/v1/models`, {
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}` },
			});
			expect(listing.status).toBe(200);
			expect(await listing.text()).toContain(`${model.provider}/${model.id}`);

			const bad = await fetch(`${gatewayBind.url}/v1/models`, {
				headers: { Authorization: `Bearer ${BAD_AGENT_TOKEN}` },
			});
			expect(bad.status).toBe(401);

			const internal = await fetch(`${gatewayBind.url}/v1/models`, {
				headers: { Authorization: `Bearer ${INTERNAL_AGENT_TOKEN}` },
			});
			expect(internal.status).toBe(503);

			const bare = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hi" }] }),
			});
			expect(bare.status).toBe(404);

			const noCredential = await fetch(`${gatewayBind.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${GOOD_AGENT_TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: `${model.provider}/${model.id}`,
					messages: [{ role: "user", content: "hi" }],
				}),
			});
			expect(noCredential.status).toBe(401);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	});
});
