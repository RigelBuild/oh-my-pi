import { afterEach, describe, expect, it, vi } from "bun:test";
import * as updateCli from "../src/cli/update-cli";
import { checkForNewVersion } from "../src/main";
import { cfgStartupCheckUpdate, cfgUpdateChannel } from "../src/modes/settings";

const originalCompiled = process.env.PI_COMPILED;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalCompiled === undefined) delete process.env.PI_COMPILED;
	else process.env.PI_COMPILED = originalCompiled;
});

function stubUpdateSources(): string[] {
	const urls: string[] = [];
	vi.spyOn(cfgStartupCheckUpdate, "get").mockReturnValue(true);
	vi.spyOn(cfgUpdateChannel, "get").mockReturnValue("stable");
	vi.spyOn(updateCli, "isSourceCheckout").mockReturnValue(false);
	vi.spyOn(updateCli, "managedInstallName").mockResolvedValue(undefined);
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				urls.push(String(input instanceof Request ? input.url : input));
				return Response.json({ error: "unreachable" }, { status: 500 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	return urls;
}

describe("startup update check", () => {
	it("skips a compiled Rigel binary without asking any update source", async () => {
		process.env.PI_COMPILED = "true";
		const urls = stubUpdateSources();

		expect(await checkForNewVersion("18.9.2-rigel.1")).toBeUndefined();
		expect(urls).toEqual([]);
	});

	it("still asks an update source for a compiled upstream binary", async () => {
		process.env.PI_COMPILED = "true";
		const urls = stubUpdateSources();

		await checkForNewVersion("18.9.2");
		expect(urls.length).toBeGreaterThan(0);
	});
});
