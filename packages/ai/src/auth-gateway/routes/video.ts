import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { ResolvedApiKey } from "../../auth-retry";
import { classifyGatewayError } from "../../error/gateway";
import * as videoServer from "../../providers/video-server";
import { downloadVideo, pollVideo, submitVideo } from "../../video";
import type { VideoJob } from "../../video/types";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	emitGatewayUsage,
	hasGatewayUsage,
	mirrorRequestAbort,
	resolveGatewayApiKey,
	resolveGatewayModel,
} from "../dispatch";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../bounded-body";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";
import type { CallerIdentity } from "../types";

const VIDEO_JSON_MAX_BYTES = 25 * 1024 * 1024;

interface ResolvedVideoRequest {
	model: Model<Api>;
	upstreamId: string;
	sessionId: string;
	apiKey: ResolvedApiKey;
	controller: AbortController;
}

function aborted(): Response {
	return videoServer.formatError(499, "request_aborted", "client closed request");
}

async function resolveVideoJob(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	caller: CallerIdentity,
): Promise<ResolvedVideoRequest | Response> {
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return aborted();
	let identity: videoServer.GatewayJobIdentity;
	try {
		identity = videoServer.decodeGatewayJobId(gatewayId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return videoServer.formatError(400, "invalid_request_error", message);
	}
	const model = await resolveGatewayModel(bootOpts.resolveModel, `${identity.provider}/${identity.modelId}`, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) {
		return videoServer.formatError(
			404,
			"invalid_request_error",
			`Unknown model: ${identity.provider}/${identity.modelId}`,
		);
	}
	if (model.api !== "openrouter-video") {
		return videoServer.formatError(
			400,
			"invalid_request_error",
			`Model ${model.id} does not support video generation`,
		);
	}
	const sessionId = deterministicUuid(`video\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return videoServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	return { model, upstreamId: identity.upstreamId, sessionId, apiKey, controller };
}

function videoOptions(bootOpts: AuthGatewayRouteOptions, resolved: ResolvedVideoRequest, peer: string) {
	return {
		apiKey: buildGatewayApiKeyResolver(
			bootOpts.storage,
			resolved.model,
			resolved.sessionId,
			resolved.apiKey,
			resolved.controller.signal,
			"video",
			peer,
			undefined,
			bootOpts.onUsageLimit,
		),
		fetch: bootOpts.fetch,
		signal: resolved.controller.signal,
	};
}

function logVideoRequest(
	requestId: string,
	operation: "submit" | "poll" | "content",
	model: ResolvedVideoRequest["model"],
	peer: string,
): void {
	logger.info("auth-gateway request", {
		requestId,
		format: `video-${operation}`,
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: operation === "content",
		peer,
	});
}

// Report completed jobs on each poll; zero-cost, zero-token results remain observed only.
function recordCompletedUsage(
	bootOpts: AuthGatewayRouteOptions,
	resolved: ResolvedVideoRequest,
	req: Request,
	job: VideoJob,
	gatewayId: string,
): void {
	if (job.status !== "completed" || job.usage === undefined) return;
	const client = resolveClientIdentity(req.headers);
	bootOpts.storage.usage.observe({
		provider: resolved.model.provider,
		model: resolved.model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		costUsd: job.usage.cost.total,
		client,
	});
	if (!hasGatewayUsage(job.usage)) return;
	// Poll credentials can differ from the credential that billed the submitted job.
	emitGatewayUsage(bootOpts, {
		requestId: gatewayId,
		provider: resolved.model.provider,
		model: resolved.model.id,
		usage: job.usage,
		outcome: "ok",
		at: Date.now(),
		client,
	});
}

/** OpenRouter-compatible `POST /v1/videos` asynchronous video submit handler. */
export async function handleVideoSubmit(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	caller: CallerIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return aborted();
	let parsed: videoServer.VideoParsedRequest;
	try {
		const bytes = await readBoundedRequestBody(req, VIDEO_JSON_MAX_BYTES, controller.signal);
		parsed = videoServer.parseRequest(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const tooLarge = error instanceof RequestBodyTooLargeError;
		const message = error instanceof Error ? error.message : String(error);
		return videoServer.formatError(
			tooLarge ? 413 : 400,
			tooLarge ? "payload_too_large" : "invalid_request_error",
			message,
		);
	}
	if (controller.signal.aborted) return aborted();
	const model = await resolveGatewayModel(bootOpts.resolveModel, parsed.modelId, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) return videoServer.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (model.api !== "openrouter-video") {
		return videoServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support video generation`,
		);
	}
	const sessionId = deterministicUuid(`video\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return videoServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	logger.info("auth-gateway request", {
		requestId,
		format: "video-submit",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});
	try {
		const job = await submitVideo(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"video",
				peer,
				undefined,
				bootOpts.onUsageLimit,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		const gatewayId = videoServer.encodeGatewayJobId({
			provider: model.provider,
			modelId: model.id,
			upstreamId: job.id,
		});
		return json(
			202,
			videoServer.encodeSubmitResponse(job, req, gatewayId),
			gatewayResponseHeaders(model, { requestId, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video submit failed", { format: "video-submit", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}

/** OpenRouter-compatible `GET /v1/videos/:id` asynchronous video poll handler. */
export async function handleVideoPoll(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	caller: CallerIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const resolved = await resolveVideoJob(bootOpts, req, peer, gatewayId, caller);
	if (resolved instanceof Response) return resolved;
	logVideoRequest(requestId, "poll", resolved.model, peer);
	try {
		const job = await pollVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
		recordCompletedUsage(bootOpts, resolved, req, job, gatewayId);
		return json(
			200,
			videoServer.encodePollResponse(job, req, gatewayId),
			gatewayResponseHeaders(resolved.model, {
				requestId,
				...(job.usage !== undefined && { costUsd: job.usage.cost.total }),
				startedAt,
			}),
		);
	} catch (error) {
		if (resolved.controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video poll failed", { format: "video-poll", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}

/** OpenRouter-compatible `GET /v1/videos/:id/content` streaming video content handler. */
export async function handleVideoContent(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	caller: CallerIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const resolved = await resolveVideoJob(bootOpts, req, peer, gatewayId, caller);
	if (resolved instanceof Response) return resolved;
	logVideoRequest(requestId, "content", resolved.model, peer);
	try {
		const content = await downloadVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
		const headers = new Headers(gatewayResponseHeaders(resolved.model, { requestId, startedAt }));
		headers.set("Content-Type", content.contentType);
		headers.set("X-Content-Type-Options", "nosniff");
		if (content.contentLength !== undefined) headers.set("Content-Length", String(content.contentLength));
		return new Response(content.body, { status: 200, headers });
	} catch (error) {
		if (resolved.controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video content failed", { format: "video-content", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}
