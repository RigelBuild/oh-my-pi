import { logger } from "@oh-my-pi/pi-utils";
import { embed } from "../../embeddings";
import { classifyGatewayError } from "../../error/gateway";
import * as embeddings from "../../providers/embeddings-server";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	gatewayAttemptOutcomes,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayAccount,
	resolveGatewayApiKey,
	resolveGatewayModel,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";
import { gatewayLogContext, logGatewayRequestFailure } from "../logging";
import type { CallerIdentity } from "../types";

/** OpenAI-compatible `POST /v1/embeddings` gateway handler. */
export async function handleEmbeddings(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	caller: CallerIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => embeddings.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: embeddings.EmbeddingsParsedRequest;
	try {
		parsed = await embeddings.parseRequest(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof embeddings.EmbeddingsWireError ? error.status : 400;
		return embeddings.formatError(status, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = await resolveGatewayModel(bootOpts.resolveModel, parsed.modelId, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) {
		return embeddings.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (model.api !== "openai-embeddings") {
		return embeddings.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support embeddings`,
		);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`embeddings\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(
		bootOpts.storage,
		model,
		sessionId,
		controller.signal,
		peer,
		gatewayLogContext(requestId, caller, "embeddings", model.provider, model.id),
	);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) {
		return embeddings.formatError(apiKey.status, apiKey.type, apiKey.message);
	}
	let account = resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, apiKey.apiKey);
	let credentialId = apiKey.credentialId;

	logger.info("auth-gateway request", {
		requestId,
		format: "embeddings",
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});
	const outcomes = gatewayAttemptOutcomes(bootOpts, model, client, requestId);
	try {
		const result = await embed(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"embeddings",
				peer,
				(resolvedKey, resolvedCredentialId) => {
					account = resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, resolvedKey);
					credentialId = resolvedCredentialId;
				},
				bootOpts.onUsageLimit,
				outcomes.onAttemptFailed,
				gatewayLogContext(requestId, caller, "embeddings", model.provider, model.id),
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts, model, client, result.usage, { requestId, outcome: "ok", account, credentialId });
		return json(
			200,
			embeddings.encodeResponse(result, parsed.modelId),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		outcomes.recordFinal(credentialId, error, controller.signal.aborted ? "aborted" : "error");
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logGatewayRequestFailure(
			gatewayLogContext(requestId, caller, "embeddings", model.provider, model.id),
			classified.status,
			credentialId,
		);
		return embeddings.formatError(classified.status, classified.type, classified.message);
	}
}
