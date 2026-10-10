import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getGatewayBootConfig, readGatewayToken, runGatewayBoot } from "../../src/cli/gateway-boot";

describe("Compass gateway boot", () => {
	test("validates the mounted bearer before the broker server can start", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const tokenFile = dir.join("gateway.token");
		await Bun.write(tokenFile, " \n");

		await expect(
			runGatewayBoot({ COMPASS_GATEWAY_TOKEN_FILE: tokenFile, OMP_AUTH_BROKER_URL: undefined }),
		).rejects.toThrow("must contain one non-empty bearer token");
	});

	test("reads one mounted bearer token with a trailing newline", async () => {
		using dir = TempDir.createSync("@omp-gateway-boot-");
		const tokenFile = dir.join("gateway.token");
		await Bun.write(tokenFile, "mounted-token\n");

		expect(await readGatewayToken(tokenFile)).toBe("mounted-token");
	});

	test("uses stack defaults and accepts explicit container settings", () => {
		expect(getGatewayBootConfig({})).toEqual({
			tokenFile: "/run/compass/gateway.token",
			bind: "0.0.0.0:4000",
			drainMs: 20000,
		});
		expect(
			getGatewayBootConfig({
				COMPASS_GATEWAY_TOKEN_FILE: "/run/secrets/gateway",
				COMPASS_GATEWAY_BIND: "127.0.0.1:4000",
				COMPASS_GATEWAY_DRAIN_MS: "15000",
			}),
		).toEqual({ tokenFile: "/run/secrets/gateway", bind: "127.0.0.1:4000", drainMs: 15000 });
	});

	test("rejects invalid drain deadlines and empty bind configuration", () => {
		expect(() => getGatewayBootConfig({ COMPASS_GATEWAY_DRAIN_MS: "20s" })).toThrow(
			"COMPASS_GATEWAY_DRAIN_MS must be a positive integer",
		);
		expect(() => getGatewayBootConfig({ COMPASS_GATEWAY_DRAIN_MS: "2147481648" })).toThrow(
			"COMPASS_GATEWAY_DRAIN_MS must be a positive integer no greater than 2147481647",
		);
		expect(getGatewayBootConfig({ COMPASS_GATEWAY_DRAIN_MS: "2147481647" }).drainMs).toBe(2147481647);
		expect(() => getGatewayBootConfig({ COMPASS_GATEWAY_BIND: "" })).toThrow(
			"COMPASS_GATEWAY_BIND must not be empty",
		);
	});
});
