import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { currentBuildHost } from "../../src/cli/build-service";
import { fixedNpmRegistry } from "../../src/cli/npm-registry";
import {
	buildBunInstallArgs,
	buildNpmInstallArgs,
	getLatestRelease,
	isRigelBuildVersion,
	runUpdateCommand,
} from "../../src/cli/update-cli";
import { cfgUpdateChannel } from "../../src/modes/settings";

describe("isRigelBuildVersion", () => {
	it("matches only positive numbered Rigel build versions", () => {
		expect(isRigelBuildVersion("18.9.2-rigel.1")).toBe(true);
		expect(isRigelBuildVersion("18.9.2-rigel.12")).toBe(true);
		expect(isRigelBuildVersion("18.9.2-rigel.0")).toBe(false);
		expect(isRigelBuildVersion("18.9.2-rigel")).toBe(false);
		expect(isRigelBuildVersion("18.9.2-canary.1")).toBe(false);
	});
});
const npmjs = fixedNpmRegistry();
// Upstream-path tests pin a non-Rigel running version, so they hold on a Rigel build too.
const UPSTREAM = "18.9.2";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand version source", () => {
	const previousPath = process.env.PATH;
	const previousBuildUrl = process.env.PI_BUILD_URL;
	const dirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		process.env.PATH = previousPath;
		if (previousBuildUrl === undefined) delete process.env.PI_BUILD_URL;
		else process.env.PI_BUILD_URL = previousBuildUrl;
		await Promise.all(dirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	/**
	 * Make PATH a fresh directory holding only what the test puts there, so no
	 * brew, mise, bun, npm, or omp of the host takes part in target resolution.
	 */
	async function isolatePath(): Promise<string> {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-path-")));
		dirs.push(dir);
		process.env.PATH = dir;
		return dir;
	}

	/** Route global fetch through `respond`, recording each request. */
	function stubFetch(respond: (url: string) => Response): Array<{ url: string; signal?: AbortSignal | null }> {
		const requests: Array<{ url: string; signal?: AbortSignal | null }> = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				requests.push({ url: String(input), signal: init?.signal });
				return respond(String(input));
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return requests;
	}

	function quiet(): { logs: string[] } {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code}): ${logs.join("\n")}`);
		}) as typeof process.exit);
		vi.spyOn(cfgUpdateChannel, "get").mockReturnValue("stable");
		return { logs };
	}

	it("checks npm, with a timeout, when no standalone binary is on PATH", async () => {
		await isolatePath();
		process.env.PI_BUILD_URL = "https://build.test";
		quiet();
		const requests = stubFetch(() => Response.json({ version: "999.0.0" }));

		await runUpdateCommand({ force: false, check: true }, UPSTREAM);

		expect(requests.length).toBeGreaterThan(0);
		expect(requests.some(request => request.url.startsWith("https://build.test/"))).toBe(false);
		for (const request of requests) expect(request.signal).toBeInstanceOf(AbortSignal);
	});
	it("looks up Rigel releases with the rigel dist-tag and pins every npm package", async () => {
		vi.restoreAllMocks();
		const requests = stubFetch(() => Response.json({ version: "18.9.2" }));

		const release = await getLatestRelease({ registries: npmjs }, "18.9.2-rigel.1");

		expect(requests.map(request => request.url)).toEqual([
			"https://registry.npmjs.org/@rigelbuild%2fomp-coding-agent/rigel",
		]);
		expect(release.packages).toEqual({ pkg: "@rigelbuild/omp-coding-agent", natives: "@rigelbuild/omp-natives" });
		const bunArgs = buildBunInstallArgs(release.version, "linux-x64", undefined, {}, "18.9.2-rigel.1");
		const npmArgs = buildNpmInstallArgs(release.version, "linux-x64", undefined, {}, "18.9.2-rigel.1");
		for (const args of [bunArgs, npmArgs]) {
			expect(args).toContain("@rigelbuild/omp-coding-agent@18.9.2");
			expect(args).toContain("@rigelbuild/omp-natives@18.9.2");
			expect(args).toContain("@rigelbuild/omp-natives-linux-x64@18.9.2");
		}
	});

	it("keeps the upstream latest lookup for non-Rigel versions", async () => {
		vi.restoreAllMocks();
		const requests = stubFetch(() => Response.json({ version: "19.0.0" }));

		await getLatestRelease({ registries: npmjs }, "19.0.0");

		expect(requests.map(request => request.url)).toEqual([
			"https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest",
		]);
	});
	it("refuses a Rigel canary lookup", async () => {
		await expect(getLatestRelease({ channel: "canary", registries: npmjs }, "18.9.2-rigel.1")).rejects.toThrow(
			"Canary updates are not available for Rigel builds",
		);
	});

	it("refuses a Rigel canary update with a non-zero exit", async () => {
		await isolatePath();
		const { logs } = quiet();
		const requests = stubFetch(() => Response.json({ version: "19.0.0-canary.1" }));

		await expect(
			runUpdateCommand({ force: false, check: false, channel: "canary" }, "18.9.2-rigel.1"),
		).rejects.toThrow("process.exit(1):");

		expect(logs.some(line => line.includes("Canary updates are not available for Rigel builds"))).toBe(true);
		expect(requests).toHaveLength(0);
	});
	it("refuses a persisted Rigel canary update", async () => {
		await isolatePath();
		const { logs } = quiet();
		vi.spyOn(cfgUpdateChannel, "get").mockReturnValue("canary");
		const requests = stubFetch(() => Response.json({ version: "18.9.2-canary.1" }));

		await expect(runUpdateCommand({ force: false, check: true }, "18.9.2-rigel.1")).rejects.toThrow(
			"process.exit(1):",
		);

		expect(logs.some(line => line.includes("Canary updates are not available for Rigel builds"))).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it.skipIf(process.platform === "win32")("does not query upstream builds for a Rigel binary", async () => {
		const dir = await isolatePath();
		const ompPath = path.join(dir, "omp");
		await Bun.write(ompPath, "#!/bin/sh\necho omp/18.9.2-rigel.1\n");
		await fs.chmod(ompPath, 0o755);
		process.env.PI_BUILD_URL = "https://build.test";
		const { logs } = quiet();
		const requests = stubFetch(() => new Response(null, { status: 404 }));

		await expect(runUpdateCommand({ force: false, check: false }, "18.9.2-rigel.1")).rejects.toThrow(
			"process.exit(1):",
		);

		expect(
			logs.some(line => line.includes("Rigel binary updates from the GitHub releases of RigelBuild/oh-my-pi")),
		).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it.skipIf(process.platform === "win32")(
		"updates a standalone binary from the build service without asking npm",
		async () => {
			const dir = await isolatePath();
			const ompPath = path.join(dir, "omp");
			await Bun.write(ompPath, "#!/bin/sh\necho omp/1.0.0\n");
			await fs.chmod(ompPath, 0o755);
			const next = "#!/bin/sh\necho omp/999.0.0\n";
			const { target, fileName } = await currentBuildHost();
			process.env.PI_BUILD_URL = "https://build.test";
			const check = `https://build.test/api/products/omp/latest/${target}?channel=stable&from_version=${UPSTREAM}`;
			const { logs } = quiet();
			const requests = stubFetch(url => {
				if (url === check) {
					return Response.json({
						build: { version: "999.0.0" },
						file: { name: fileName, size: Buffer.byteLength(next), sha256: Bun.SHA256.hash(next, "hex") },
						download: "https://r2.test/omp",
					});
				}
				if (url === "https://r2.test/omp") return new Response(next);
				return new Response(null, { status: 404 });
			});

			await runUpdateCommand({ force: false, check: false }, UPSTREAM);

			expect(requests.map(request => request.url)).toEqual([check, "https://r2.test/omp"]);
			expect(await Bun.file(ompPath).text()).toBe(next);
			expect(logs.some(line => line.includes("Updated to 999.0.0"))).toBe(true);
		},
	);

	it("reports Rigel update candidates from npm without build-service calls", async () => {
		await isolatePath();
		const { logs } = quiet();
		const requests = stubFetch(() => Response.json({ version: "18.9.2" }));

		await runUpdateCommand({ force: false, check: true }, "18.9.2-rigel.1");

		expect(requests.map(request => request.url)).toEqual([
			"https://registry.npmjs.org/@rigelbuild%2fomp-coding-agent/rigel",
		]);
		expect(logs.some(line => line.includes("New version available: 18.9.2"))).toBe(true);
	});
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				const decoded = decodeURIComponent(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (decoded.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs }, UPSTREAM);

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest",
			"https://registry.npmjs.org/@new%2fomp/latest",
		]);
	});
	it("fetches the canary dist-tag when checking the canary channel", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": { version: "999.0.0-canary.1" },
		});

		await getLatestRelease({ channel: "canary", registries: npmjs }, UPSTREAM);

		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/canary"]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs }, UPSTREAM);

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

describe("getLatestRelease configured registry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const feed = () => ({
		url: "https://npm.corp.example/api/npm/feed/",
		source: "/home/u/.npmrc",
		authorization: "Bearer s3cret",
	});

	it("queries the configured feed with its credentials and reports it for the install pin", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput, init?: FetchInit) => {
					requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
					return Response.json({ version: "999.0.0" });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed }, UPSTREAM);

		expect(requests).toEqual([
			{
				url: "https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
				authorization: "Bearer s3cret",
			},
		]);
		expect(release.registry).toBe("https://npm.corp.example/api/npm/feed/");
	});
	it("uses the Rigel dist-tag when falling back to a full packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/rigel")) return new Response(null, { status: 404, statusText: "Not Found" });
					return Response.json({
						"dist-tags": { rigel: "18.9.2-rigel.1" },
						versions: { "18.9.2-rigel.1": { version: "18.9.2-rigel.1" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed }, "18.9.2-rigel.1");

		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@rigelbuild%2fomp-coding-agent/rigel",
			"https://npm.corp.example/api/npm/feed/@rigelbuild%2fomp-coding-agent",
		]);
		expect(release.version).toBe("18.9.2-rigel.1");
	});
	it("reports a missing Rigel dist-tag after feed shortcut fallback", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/rigel")) return new Response(null, { status: 404, statusText: "Not Found" });
					return Response.json({
						"dist-tags": { latest: "18.9.2" },
						versions: { "18.9.2": { version: "18.9.2" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ registries: feed }, "18.9.2-rigel.1")).rejects.toThrow("missing dist-tags.rigel");
		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@rigelbuild%2fomp-coding-agent/rigel",
			"https://npm.corp.example/api/npm/feed/@rigelbuild%2fomp-coding-agent",
		]);
	});

	it("falls back to the full packument when the feed does not serve the dist-tag shortcut", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response(null, { status: 404, statusText: "Not Found" });
					return Response.json({
						"dist-tags": { latest: "999.2.0" },
						versions: { "999.2.0": { version: "999.2.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed }, UPSTREAM);

		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent",
		]);
		expect(release.version).toBe("999.2.0");
		expect(release.dist).toBe("binary");
	});

	it("resolves the tagged version when the feed answers the dist-tag shortcut with the full packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					urls.push(String(input));
					return Response.json({
						"dist-tags": { latest: "999.3.0" },
						versions: { "999.3.0": { version: "999.3.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed }, UPSTREAM);

		expect(urls).toEqual(["https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest"]);
		expect(release.version).toBe("999.3.0");
		expect(release.dist).toBe("binary");
	});

	it("falls back to the full packument when the shortcut returns 200 without a version", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return Response.json({ success: false, error: "not found" });
					return Response.json({
						"dist-tags": { latest: "999.4.0" },
						versions: { "999.4.0": { version: "999.4.0" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed }, UPSTREAM);

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.4.0");
	});

	it("falls back to the full packument when the shortcut returns 200 with a non-JSON body", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response("<html>Nexus</html>", { status: 200 });
					return Response.json({
						"dist-tags": { latest: "999.5.0" },
						versions: { "999.5.0": { version: "999.5.0" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed }, UPSTREAM);

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.5.0");
	});

	it("surfaces a body-read failure on the shortcut instead of retrying the packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					urls.push(String(input));
					const body = new ReadableStream({
						start(controller) {
							controller.error(new Error("connection reset mid-body"));
						},
					});
					return new Response(body, { status: 200 });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ registries: feed }, UPSTREAM)).rejects.toThrow("connection reset mid-body");
		expect(urls).toHaveLength(1);
	});

	it("reports a missing canary dist-tag on the feed as no canary release", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) =>
					String(input).endsWith("/canary")
						? new Response(null, { status: 404, statusText: "Not Found" })
						: Response.json({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } } }),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ channel: "canary", registries: feed }, UPSTREAM)).rejects.toThrow(
			"No canary release has been published",
		);
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000, registries: npmjs }, UPSTREAM).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
