import * as fs from "node:fs/promises";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { AuthCredentialStore, Model } from "@oh-my-pi/pi-ai";
import { presentedBearer, startAuthGateway, withEnrollToken } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayAuthorizer } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	CompassOwnerPool,
	createCompassAgentVerifier,
	normalizeCompassBaseUrl,
	openCompassOwner,
	probeCompassDoor,
	runWithAgentToken,
} from "@oh-my-pi/pi-ai/compass";
import type { Api } from "@oh-my-pi/pi-ai/types";
import { installGlobalProxyFetch } from "@oh-my-pi/pi-ai/utils/proxy";
import { getBundledModels, getBundledProviders, isGeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { VERSION } from "@oh-my-pi/pi-utils";
import { GATEWAY_MODEL_KINDS, MAX_GATEWAY_DRAIN_MS, registerGatewayShutdown } from "./auth-gateway-cli";

const DEFAULT_SERVICE_TOKEN_FILE = "/run/compass/service.token";
const DEFAULT_BIND = "0.0.0.0:4000";
const DEFAULT_DRAIN_MS = 20_000;

export interface GatewayBootConfig {
	serviceTokenFile: string;
	serverUrl: string;
	caFile?: string;
	bind: string;
	drainMs: number;
	enrollTokenFile?: string;
}

export function getGatewayBootConfig(env: Readonly<Record<string, string | undefined>>): GatewayBootConfig {
	const serviceTokenFile = env.COMPASS_SERVICE_TOKEN_FILE ?? DEFAULT_SERVICE_TOKEN_FILE;
	if (!serviceTokenFile) throw new Error("COMPASS_SERVICE_TOKEN_FILE must not be empty");
	const serverUrlValue = env.COMPASS_SERVER_URL;
	if (!serverUrlValue) throw new Error("COMPASS_SERVER_URL is required");
	let serverUrl: string;
	try {
		serverUrl = normalizeCompassBaseUrl(serverUrlValue);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "invalid URL";
		throw new Error(`COMPASS_SERVER_URL is invalid: ${reason}`, { cause: error });
	}
	const caFile = env.COMPASS_SERVER_CA_FILE;
	if (new URL(serverUrl).protocol === "https:" && !caFile) {
		throw new Error("COMPASS_SERVER_CA_FILE is required when COMPASS_SERVER_URL uses https");
	}
	if (caFile === "") throw new Error("COMPASS_SERVER_CA_FILE must not be empty");

	const bind = env.COMPASS_GATEWAY_BIND ?? DEFAULT_BIND;
	if (bind.length === 0) throw new Error("COMPASS_GATEWAY_BIND must not be empty");

	const drainValue = env.COMPASS_GATEWAY_DRAIN_MS;
	const drainMs = drainValue === undefined ? DEFAULT_DRAIN_MS : Number(drainValue);
	if (!Number.isSafeInteger(drainMs) || drainMs <= 0 || drainMs > MAX_GATEWAY_DRAIN_MS) {
		throw new Error(`COMPASS_GATEWAY_DRAIN_MS must be a positive integer no greater than ${MAX_GATEWAY_DRAIN_MS}`);
	}

	const enrollTokenFile = env.COMPASS_GATEWAY_ENROLL_TOKEN_FILE;
	if (enrollTokenFile === "") throw new Error("COMPASS_GATEWAY_ENROLL_TOKEN_FILE must not be empty");
	return { serviceTokenFile, serverUrl, caFile, bind, drainMs, enrollTokenFile };
}

export async function readTokenFile(path: string, envName: string): Promise<string> {
	let contents: string;
	try {
		contents = await fs.readFile(path, "utf8");
	} catch {
		throw new Error(`${envName} could not be read`);
	}
	const token = contents.trim();
	if (!token || /\s/.test(token)) throw new Error(`${envName} must contain one non-empty token`);
	return token;
}

export function buildGatewayCatalog(): {
	resolveModel: (modelId: string) => Model<Api> | undefined;
	listModels: () => Iterable<Model<Api>>;
} {
	// This isolates the undecided catalog so its implementation can change without rewiring boot.
	const models = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		if (!isGeneratedProvider(provider)) continue;
		for (const model of getBundledModels(provider)) {
			if (!GATEWAY_MODEL_KINDS.includes(modelKind(model))) continue;
			models.set(`${model.provider}/${model.id}`, model);
		}
	}
	return {
		resolveModel: modelId => models.get(modelId),
		listModels: () => models.values(),
	};
}

function createPlaceholderStorage(): AuthStorage {
	const fail = (): never => {
		throw new Error("Placeholder auth storage is unavailable");
	};
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: fail,
		updateAuthCredential: fail,
		deleteAuthCredential: fail,
		tryDisableAuthCredentialIfMatches: fail,
		replaceAuthCredentials: fail,
		upsertAuthCredential: fail,
		deleteAuthCredentials: fail,
		getCache: fail,
		setCache: fail,
		cleanExpiredCache: fail,
	};
	return new AuthStorage(store);
}

export async function runGatewayBoot(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
	const config = getGatewayBootConfig(env);
	const serviceToken = await readTokenFile(config.serviceTokenFile, "COMPASS_SERVICE_TOKEN_FILE");
	let ca: string | undefined;
	if (config.caFile !== undefined) {
		try {
			ca = await fs.readFile(config.caFile, "utf8");
		} catch {
			throw new Error("COMPASS_SERVER_CA_FILE could not be read");
		}
		if (!ca.trim()) throw new Error("COMPASS_SERVER_CA_FILE must contain CA certificates");
	}
	const enrollToken =
		config.enrollTokenFile === undefined
			? undefined
			: await readTokenFile(config.enrollTokenFile, "COMPASS_GATEWAY_ENROLL_TOKEN_FILE");

	const compassBaseFetch = globalThis.fetch;
	installGlobalProxyFetch();
	const compassFetch = Object.assign(
		(input: string | URL | Request, init?: RequestInit) =>
			compassBaseFetch(input, ca === undefined ? init : ({ ...init, tls: { ca } } satisfies BunFetchRequestInit)),
		{ preconnect: compassBaseFetch.preconnect },
	);
	const verifierOptions = { baseUrl: config.serverUrl, token: serviceToken, fetch: compassFetch };
	await probeCompassDoor(verifierOptions);

	const pool = new CompassOwnerPool({
		open: () => openCompassOwner({ baseUrl: config.serverUrl, token: serviceToken, fetch: compassFetch }),
	});
	let authorize: AuthGatewayAuthorizer = createCompassAgentVerifier(verifierOptions);
	if (enrollToken !== undefined) authorize = withEnrollToken(enrollToken, authorize);
	const placeholder = createPlaceholderStorage();
	const catalog = buildGatewayCatalog();
	const handle = startAuthGateway({
		bind: config.bind,
		authorize,
		storage: placeholder,
		resolveStorage: caller => {
			if (!caller.ownerUserId) throw new Error("Compass caller has no owner user id");
			return pool.get(caller.ownerUserId);
		},
		routeScope: (req, run) => {
			const token = presentedBearer(req);
			const leased = () => pool.withRequestLease(run);
			return token ? runWithAgentToken(token, leased) : leased();
		},
		resolveModel: catalog.resolveModel,
		listModels: catalog.listModels,
		version: VERSION,
	});
	registerGatewayShutdown(handle, config.drainMs, () => {
		pool.close();
		placeholder.close();
	});
}

if (import.meta.main) {
	await runGatewayBoot();
}
