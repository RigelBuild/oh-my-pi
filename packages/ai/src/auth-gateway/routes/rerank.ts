import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import * as rerankWire from "../../providers/rerank-server";
import { rerank } from "../../rerank";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	gatewayAttemptOutcomes,
	gatewayRequestLogFields,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayAccount,
	resolveGatewayApiKey,
	resolveGatewayModel,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity, codedErrorResponse } from "../http";
import { gatewayLogContext, logGatewayRequestFailure } from "../logging";
import type { CallerIdentity } from "../types";

/** OpenRouter-compatible `POST /v1/rerank` gateway handler. */
export async function handleRerank(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	caller: CallerIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => codedErrorResponse(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let parsed: rerankWire.RerankParsedRequest;
	try {
		parsed = await rerankWire.parseRequest(req);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof rerankWire.RerankWireError ? error.status : 400;
		return codedErrorResponse(status, "invalid_request_error", message);
	}
	if (controller.signal.aborted) return aborted();

	const model = await resolveGatewayModel(bootOpts.resolveModel, parsed.modelId, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) return codedErrorResponse(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (model.api !== "openrouter-rerank") {
		return codedErrorResponse(400, "invalid_request_error", `Model ${parsed.modelId} does not support reranking`);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`rerank\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(
		bootOpts,
		model,
		sessionId,
		controller.signal,
		peer,
		gatewayLogContext(requestId, caller, "rerank", model.provider, model.id),
	);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return codedErrorResponse(apiKey.status, apiKey.type, apiKey.message);

	let account = resolveGatewayAccount(apiKey);
	let credentialId = apiKey.credentialId;
	logger.info("auth-gateway request", {
		requestId,
		format: "rerank",
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
		...gatewayRequestLogFields(bootOpts, apiKey),
	});

	const outcomes = gatewayAttemptOutcomes(bootOpts, model, client, requestId);
	try {
		const result = await rerank(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"rerank",
				peer,
				resolved => {
					account = resolveGatewayAccount(resolved);
					credentialId = resolved.credentialId;
				},
				bootOpts.onUsageLimit,
				outcomes.onAttemptFailed,
				gatewayLogContext(requestId, caller, "rerank", model.provider, model.id),
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		recordGatewayUsage(bootOpts, model, client, result.usage, { requestId, outcome: "ok", account, credentialId });
		return json(
			200,
			rerankWire.encodeResponse(
				result,
				parsed.modelId,
				parsed.originalDocuments,
				parsed.request.returnDocuments ?? false,
			),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		outcomes.recordFinal(credentialId, error, controller.signal.aborted ? "aborted" : "error");
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logGatewayRequestFailure(
			gatewayLogContext(requestId, caller, "rerank", model.provider, model.id),
			classified.status,
			credentialId,
		);
		return codedErrorResponse(classified.status, classified.type, classified.message);
	}
}
