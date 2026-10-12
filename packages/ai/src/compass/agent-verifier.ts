import type { AuthGatewayAuthorizer } from "../auth-gateway/types";
import { presentedBearer } from "../auth-gateway/http";
import {
	CompassRpcError,
	compassRpcErrorFromResponse,
	decodeCompassJson,
	fetchCompassRpcResponse,
	normalizeCompassBaseUrl,
	verifyAgentTokenResponseSchema,
} from "./wire";

export interface CompassAgentVerifierOptions {
	baseUrl: string;
	/** Compass llm-gateway service bearer, not the presented agent token. */
	token: string;
	fetch?: typeof fetch;
	/** Deadline for verification calls. Default 5_000 ms. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const VERIFY_SERVICE = "GatewayAuth";
const VERIFY_METHOD = "VerifyAgentToken";
const INVALID_AGENT_TOKEN = "invalid agent token";

function createVerifier(opts: CompassAgentVerifierOptions) {
	const baseUrl = normalizeCompassBaseUrl(opts.baseUrl);
	if (!opts.token.trim()) throw new Error("Compass token must not be empty");
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("Compass timeoutMs must be finite and greater than zero");
	const fetcher = opts.fetch ?? fetch;

	return async (
		token: string,
		signal: AbortSignal,
	): Promise<{ kind: "agent"; agentAccountId: string; ownerUserId: string } | null> => {
		let result: { response: Response; text: string };
		try {
			result = await fetchCompassRpcResponse({
				baseUrl,
				service: VERIFY_SERVICE,
				method: VERIFY_METHOD,
				token: opts.token,
				fetch: fetcher,
				body: { token },
				signal,
			});
		} catch {
			if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
				throw new CompassRpcError("deadline_exceeded", "Compass agent verification timed out");
			}
			if (signal.aborted) throw new CompassRpcError("canceled", "Compass agent verification was canceled");
			throw new CompassRpcError("unavailable", "Compass agent verification failed");
		}

		if (!result.response.ok) {
			const rpcError = compassRpcErrorFromResponse(result.response.status, result.text);
			if (rpcError.code === "unauthenticated" && rpcError.message === INVALID_AGENT_TOKEN) return null;
			throw new CompassRpcError(rpcError.code, "Compass agent verification failed");
		}

		const verified = decodeCompassJson(result.text, verifyAgentTokenResponseSchema);
		if (!verified.agentAccountId || !verified.ownerUserId) {
			throw new CompassRpcError("invalid_response", "Compass agent verification returned an empty id");
		}
		return { kind: "agent", agentAccountId: verified.agentAccountId, ownerUserId: verified.ownerUserId };
	};
}

export function createCompassAgentVerifier(opts: CompassAgentVerifierOptions): AuthGatewayAuthorizer {
	const verify = createVerifier(opts);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return req => {
		const token = presentedBearer(req);
		if (token === undefined) return null;
		return verify(token, AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]));
	};
}

export async function probeCompassDoor(opts: CompassAgentVerifierOptions): Promise<void> {
	const verify = createVerifier(opts);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const result = await verify("", AbortSignal.any([AbortSignal.timeout(timeoutMs)]));
	if (result !== null)
		throw new CompassRpcError("invalid_response", "Compass door probe unexpectedly verified an empty token");
}
