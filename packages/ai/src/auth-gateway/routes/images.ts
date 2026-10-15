import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyGatewayError } from "../../error/gateway";
import { generateImage } from "../../images";
import * as imagesServer from "../../providers/images-server";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayAccount,
	resolveGatewayApiKey,
	resolveGatewayModel,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";
import type { CallerIdentity } from "../types";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../bounded-body";

const IMAGE_JSON_MAX_BYTES = 48 * 1024 * 1024;
const IMAGE_MULTIPART_MAX_BYTES = 36 * 1024 * 1024;
const IMAGE_MULTIPART_MAX_PARTS = 24;
const IMAGE_MULTIPART_MAX_FILES = 16;

// Count part-start delimiters before FormData can expand the bounded wire body.
function countMultipartParts(bytes: Uint8Array, boundary: Uint8Array): number {
	let parts = 0;
	for (let i = 0; i <= bytes.byteLength - boundary.byteLength; i++) {
		if (i > 0 && (bytes[i - 2] !== 13 || bytes[i - 1] !== 10)) continue;
		let matches = true;
		for (let j = 0; j < boundary.byteLength; j++) {
			if (bytes[i + j] !== boundary[j]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		const end = i + boundary.byteLength;
		if (bytes[end] === 13 && bytes[end + 1] === 10) {
			parts++;
			i = end + 1;
		} else if (bytes[end] === 45 && bytes[end + 1] === 45) {
			i = end + 1;
		}
	}
	return parts;
}

function isGatewayImageApi(api: string): boolean {
	return (
		api === "openai-images" ||
		api === "openrouter-images" ||
		api === "google-generative-ai" ||
		api === "google-gemini-cli"
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
	const aborted = (): Response => imagesServer.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown | FormData;
	const contentType = req.headers.get("content-type") ?? "";
	const mediaType = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
	const multipart = kind === "edits" && mediaType === "multipart/form-data";
	try {
		const maxBytes = multipart ? IMAGE_MULTIPART_MAX_BYTES : IMAGE_JSON_MAX_BYTES;
		const bytes = await readBoundedRequestBody(req, maxBytes, controller.signal);
		if (multipart) {
			// A quoted boundary is used verbatim, spaces included, as formData() does.
			const boundary = /;\s*boundary\s*=\s*(?:"([^"\\]*)"|([^;\s]+))/i.exec(contentType);
			const boundaryValue = boundary?.[1] ?? boundary?.[2];
			if (!boundaryValue) {
				return imagesServer.formatError(400, "invalid_request_error", "Multipart body needs a boundary");
			}
			const tooManyParts = (): Response =>
				imagesServer.formatError(
					400,
					"invalid_request_error",
					`Multipart body must not exceed ${IMAGE_MULTIPART_MAX_PARTS} parts`,
				);
			const boundaryBytes = new TextEncoder().encode(`--${boundaryValue}`);
			if (countMultipartParts(bytes, boundaryBytes) > IMAGE_MULTIPART_MAX_PARTS) return tooManyParts();
			const form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
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
			return imagesServer.formatError(413, "payload_too_large", error.message);
		}
		return imagesServer.formatError(400, "invalid_request_error", `Invalid request body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: imagesServer.ImagesParsedRequest;
	try {
		parsed = await imagesServer.parseRequest(body, kind);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return imagesServer.formatError(400, "invalid_request_error", message);
	}

	const model = await resolveGatewayModel(bootOpts.resolveModel, parsed.modelId, caller);
	if (controller.signal.aborted) return aborted();
	if (!model) {
		return imagesServer.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		return imagesServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} requires a hosted image carrier, which the auth gateway cannot resolve`,
		);
	}
	if (!isGatewayImageApi(model.api)) {
		return imagesServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support image generation`,
		);
	}

	const client = resolveClientIdentity(req.headers);
	const sessionId = deterministicUuid(`images\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return imagesServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	let account = resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, apiKey.apiKey);

	logger.info("auth-gateway request", {
		requestId,
		format: "images",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});

	try {
		const result = await generateImage(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"images",
				peer,
				resolvedKey => {
					account = resolveGatewayAccount(bootOpts.storage, model.provider, sessionId, resolvedKey);
				},
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		if (result.usage.cost.total === 0) calculateCost(model, result.usage);
		recordGatewayUsage(bootOpts, model, client, result.usage, { requestId, outcome: "ok", account });
		return json(
			200,
			imagesServer.encodeResponse(result, parsed.modelId),
			gatewayResponseHeaders(model, { requestId, costUsd: result.usage.cost.total, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway image generation failed", { format: "images", error: classified.message, peer });
		return imagesServer.formatError(classified.status, classified.type, classified.message);
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
