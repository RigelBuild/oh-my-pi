import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import { generateImage } from "../../images";
import { validateImageInput } from "../../images/shared";
import * as imagesServer from "../../providers/images-server";
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
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../bounded-body";

const IMAGE_JSON_MAX_BYTES = 48 * 1024 * 1024;
const IMAGE_MULTIPART_MAX_BYTES = 36 * 1024 * 1024;
const IMAGE_MULTIPART_MAX_PARTS = 24;
const IMAGE_MULTIPART_MAX_FILES = 16;

// Count `--boundary\r\n` openers before the last `--boundary--`; null when there is no close.
// Bun's formData() starts a part at any such opener, glued to prior data or not, ignores
// everything after the last close, and without a close throws only after parsing every part.
function countPartOpeners(bytes: Uint8Array, boundary: string): number | null {
	const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = view.lastIndexOf(`--${boundary}--`);
	if (end === -1) return null;
	const opener = `--${boundary}\r\n`;
	let count = 0;
	for (let i = view.indexOf(opener); i !== -1 && i < end; i = view.indexOf(opener, i + opener.length)) count++;
	return count;
}

// RFC 2046 boundary: 1-70 bchars, not ending in space.
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

// The single boundary parameter, honouring quoted strings; null when absent, repeated, malformed, or invalid.
function multipartBoundary(contentType: string): string | null {
	const params = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s"]*))\s*/y;
	let pos = contentType.indexOf(";");
	if (pos < 0) return null;
	let boundary: string | null = null;
	while (pos < contentType.length) {
		params.lastIndex = pos;
		const m = params.exec(contentType);
		if (!m) return null;
		pos = params.lastIndex;
		if (m[1]?.toLowerCase() !== "boundary") continue;
		if (boundary !== null) return null;
		boundary = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "");
	}
	return boundary !== null && BOUNDARY_RE.test(boundary) ? boundary : null;
}

function isGatewayImageApi(api: string): boolean {
	return (
		api === "openai-images" ||
		api === "openrouter-images" ||
		api === "google-generative-ai" ||
		api === "google-gemini-cli" ||
		api === "factory-droid-agent"
	);
}

async function handleImages(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	kind: imagesServer.ImageRequestKind,
	caller: CallerIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => codedErrorResponse(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown | FormData;
	const contentType = req.headers.get("content-type") ?? "";
	const mediaType = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
	const multipart = kind === "edits" && mediaType === "multipart/form-data";
	try {
		const maxBytes = multipart ? IMAGE_MULTIPART_MAX_BYTES : IMAGE_JSON_MAX_BYTES;
		const bytes = await readBoundedRequestBody(req, maxBytes, controller.signal);
		if (multipart) {
			const boundaryValue = multipartBoundary(contentType);
			if (!boundaryValue) {
				return imagesServer.formatError(400, "invalid_request_error", "Multipart body needs one valid boundary");
			}
			const partCount = countPartOpeners(bytes, boundaryValue);
			if (partCount === null) {
				return imagesServer.formatError(400, "invalid_request_error", "Multipart body has no closing boundary");
			}
			if (partCount > IMAGE_MULTIPART_MAX_PARTS) {
				return imagesServer.formatError(
					400,
					"invalid_request_error",
					`Multipart body must not exceed ${IMAGE_MULTIPART_MAX_PARTS} parts`,
				);
			}
			// Parse with the boundary just counted, not the client's header, so both agree.
			const canonical = `multipart/form-data; boundary="${boundaryValue}"`;
			const form = await new Response(bytes, { headers: { "Content-Type": canonical } }).formData();
			const imageFiles = [...form.getAll("image"), ...form.getAll("image[]")].filter(value => value instanceof File);
			if (imageFiles.length > IMAGE_MULTIPART_MAX_FILES) {
				return imagesServer.formatError(
					400,
					"invalid_request_error",
					`Multipart body must not exceed ${IMAGE_MULTIPART_MAX_FILES} image files`,
				);
			}
			body = form;
		} else {
			body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		}
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		if (error instanceof RequestBodyTooLargeError) {
			return codedErrorResponse(413, "payload_too_large", error.message);
		}
		return codedErrorResponse(400, "invalid_request_error", `Invalid request body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: imagesServer.ImagesParsedRequest;
	try {
		parsed = await imagesServer.parseRequest(body, kind);
		for (const image of parsed.request.inputImages ?? []) validateImageInput(image);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return codedErrorResponse(400, "invalid_request_error", message);
	}

	const model = await resolveGatewayModel(bootOpts.resolveModel, parsed.modelId, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) {
		return codedErrorResponse(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		return codedErrorResponse(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} requires a hosted image carrier, which the auth gateway cannot resolve`,
		);
	}
	if (!isGatewayImageApi(model.api)) {
		return codedErrorResponse(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support image generation`,
		);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`images\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(
		bootOpts,
		model,
		sessionId,
		controller.signal,
		peer,
		gatewayLogContext(requestId, caller, "images", model.provider, model.id),
	);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return codedErrorResponse(apiKey.status, apiKey.type, apiKey.message);
	let account = resolveGatewayAccount(apiKey);
	let credentialId = apiKey.credentialId;

	logger.info("auth-gateway request", {
		requestId,
		format: "images",
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
		...gatewayRequestLogFields(bootOpts, apiKey),
	});

	const outcomes = gatewayAttemptOutcomes(bootOpts, model, client, requestId);
	try {
		const result = await generateImage(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"images",
				peer,
				resolved => {
					account = resolveGatewayAccount(resolved);
					credentialId = resolved.credentialId;
				},
				bootOpts.onUsageLimit,
				outcomes.onAttemptFailed,
				gatewayLogContext(requestId, caller, "images", model.provider, model.id),
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		if (result.usage.cost.total === 0) calculateCost(model, result.usage);
		recordGatewayUsage(bootOpts, model, client, result.usage, { requestId, outcome: "ok", account, credentialId });
		return json(
			200,
			imagesServer.encodeResponse(result, parsed.modelId),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		outcomes.recordFinal(credentialId, error, controller.signal.aborted ? "aborted" : "error");
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logGatewayRequestFailure(
			gatewayLogContext(requestId, caller, "images", model.provider, model.id),
			classified.status,
			credentialId,
		);
		return codedErrorResponse(classified.status, classified.type, classified.message);
	}
}

export function handleImageGenerations(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	caller: CallerIdentity,
): Promise<Response> {
	return handleImages(bootOpts, req, peer, "generations", caller);
}

export function handleImageEdits(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	caller: CallerIdentity,
): Promise<Response> {
	return handleImages(bootOpts, req, peer, "edits", caller);
}
