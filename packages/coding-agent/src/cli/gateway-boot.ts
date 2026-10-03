import * as fs from "node:fs/promises";
import { postmortem } from "@oh-my-pi/pi-utils";
import { installGlobalProxyFetch } from "@oh-my-pi/pi-ai/utils/proxy";
import { runAuthGatewayCommand } from "./auth-gateway-cli";

/** T1 deliberately does not provide a broker URL; the serve command still requires OMP_AUTH_BROKER_URL. */
const DEFAULT_TOKEN_FILE = "/run/compass/gateway.token";
const DEFAULT_BIND = "0.0.0.0:4000";
const DEFAULT_DRAIN_MS = 20_000;
// Room after the drain for storage close before postmortem forces the exit.
const SHUTDOWN_MARGIN_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface GatewayBootConfig {
	tokenFile: string;
	bind: string;
	drainMs: number;
}

export function getGatewayBootConfig(env: Readonly<Record<string, string | undefined>>): GatewayBootConfig {
	const tokenFile = env.COMPASS_GATEWAY_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
	if (tokenFile.length === 0) throw new Error("COMPASS_GATEWAY_TOKEN_FILE must not be empty");

	const bind = env.COMPASS_GATEWAY_BIND ?? DEFAULT_BIND;
	if (bind.length === 0) throw new Error("COMPASS_GATEWAY_BIND must not be empty");

	const drainValue = env.COMPASS_GATEWAY_DRAIN_MS;
	const drainMs = drainValue === undefined ? DEFAULT_DRAIN_MS : Number(drainValue);
	if (!Number.isSafeInteger(drainMs) || drainMs <= 0 || drainMs > MAX_TIMER_MS) {
		throw new Error("COMPASS_GATEWAY_DRAIN_MS must be a positive integer no greater than 2147483647");
	}

	return { tokenFile, bind, drainMs };
}

export async function readGatewayToken(tokenFile: string): Promise<string> {
	const token = (await fs.readFile(tokenFile, "utf8")).trim();
	if (!token || /\s/.test(token)) {
		throw new Error("COMPASS_GATEWAY_TOKEN_FILE must contain one non-empty bearer token");
	}
	return token;
}

export async function runGatewayBoot(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
	const config = getGatewayBootConfig(env);
	const gatewayToken = await readGatewayToken(config.tokenFile);
	postmortem.setCleanupDeadline(Math.min(config.drainMs + SHUTDOWN_MARGIN_MS, MAX_TIMER_MS));
	installGlobalProxyFetch();
	await runAuthGatewayCommand({
		action: "serve",
		flags: { bind: config.bind, gatewayToken, drainMs: config.drainMs },
	});
}

if (import.meta.main) {
	await runGatewayBoot();
}
