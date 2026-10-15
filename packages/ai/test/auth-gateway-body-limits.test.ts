import { describe, expect, it } from "bun:test";
import { createAuthGatewayRouter, SHARED_TOKEN_CALLER } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const imageModel = buildModel({
	id: "gpt-image-limit",
	name: "image limit test",
	provider: "openai",
	api: "openai-images",
	kind: "image",
	baseUrl: "https://openai.example/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 4096,
});
const speechModel = getBundledModel("deepinfra", "hexgrad/Kokoro-82M");
const videoModel = buildModel({
	id: "google/veo-limit",
	name: "video limit test",
	provider: "openrouter",
	api: "openrouter-video",
	kind: "video",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: null,
	maxTokens: null,
} satisfies ModelSpec<"openrouter-video">);

interface RouteCase {
	name: string;
	path: string;
	limit: number;
	body: Record<string, unknown>;
}

const routes: readonly RouteCase[] = [
	{
		name: "image JSON",
		path: "/v1/images/generations",
		limit: 48 * 1024 * 1024,
		body: { model: imageModel.id, prompt: "paint" },
	},
	{
		name: "speech JSON",
		path: "/v1/audio/speech",
		limit: 25 * 1024 * 1024,
		body: { model: speechModel.id, input: "speak" },
	},
	{
		name: "video JSON",
		path: "/v1/videos",
		limit: 25 * 1024 * 1024,
		body: { model: `openrouter/${videoModel.id}`, prompt: "a lighthouse" },
	},
];

interface RouteHarness {
	route: (req: Request) => Promise<Response>;
	upstreamCalls: number;
	close: () => void;
}

async function createHarness(): Promise<RouteHarness> {
	const storage = await AuthStorage.create(":memory:");
	storage.keys.setRuntime("openai", "image-key");
	storage.keys.setRuntime("deepinfra", "speech-key");
	storage.keys.setRuntime("openrouter", "video-key");
	let upstreamCalls = 0;
	const fetchImpl: FetchImpl = async input => {
		upstreamCalls++;
		const url = String(input);
		if (url.includes("/images")) return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
		if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]));
		if (url.endsWith("/videos")) {
			return Response.json(
				{
					id: "video-job",
					polling_url: "https://openrouter.ai/api/v1/videos/video-job",
					status: "pending",
					usage: { cost: 0 },
				},
				{ status: 202 },
			);
		}
		throw new Error(`Unexpected upstream URL: ${url}`);
	};
	const models = [imageModel, speechModel, videoModel];
	const router = createAuthGatewayRouter({
		storage,
		fetch: fetchImpl,
		resolveModel: id => models.find(model => id === model.id || id === `${model.provider}/${model.id}`),
	});
	return {
		route: req => router.route(req, "test", SHARED_TOKEN_CALLER),
		get upstreamCalls() {
			return upstreamCalls;
		},
		close: () => storage.close(),
	};
}

function requestFor(
	path: string,
	body: string | Uint8Array | ReadableStream<Uint8Array>,
	options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Request {
	return new Request(`http://gateway.test${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...options.headers },
		body: body instanceof Uint8Array ? body.slice().buffer : body,
		signal: options.signal,
		duplex: "half",
	});
}

function exactBody(route: RouteCase): string {
	const prefix = JSON.stringify(route.body);
	return `${prefix}${" ".repeat(route.limit - new TextEncoder().encode(prefix).byteLength)}`;
}

function multipartBody(boundary: string, parts: readonly string[]): Uint8Array {
	const body = `${parts.map(part => `--${boundary}\r\n${part}\r\n`).join("")}--${boundary}--\r\n`;
	return new TextEncoder().encode(body);
}

function multipartField(name: string, value: string): string {
	return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
}

function multipartFile(name: string, filename: string): string {
	return `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\nimage-data`;
}

for (const route of routes) {
	describe(`auth-gateway ${route.name} body limits`, () => {
		it("accepts a body exactly at the byte cap", async () => {
			const harness = await createHarness();
			try {
				const response = await harness.route(requestFor(route.path, exactBody(route)));
				expect(response.status).toBe(route.path === "/v1/videos" ? 202 : 200);
				expect(harness.upstreamCalls).toBe(1);
			} finally {
				harness.close();
			}
		});

		it("rejects one byte over the cap", async () => {
			const harness = await createHarness();
			try {
				const body = `${exactBody(route)} `;
				const response = await harness.route(requestFor(route.path, body));
				expect(response.status).toBe(413);
				expect(harness.upstreamCalls).toBe(0);
			} finally {
				harness.close();
			}
		});

		it("rejects declared oversize without reading the body", async () => {
			const harness = await createHarness();
			let reads = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						reads++;
						controller.enqueue(new Uint8Array([1]));
					},
				},
				{ highWaterMark: 0 },
			);
			try {
				const response = await harness.route(
					requestFor(route.path, body, {
						headers: { "Content-Length": String(route.limit + 1) },
					}),
				);
				expect(response.status).toBe(413);
				expect(reads).toBe(0);
				expect(harness.upstreamCalls).toBe(0);
			} finally {
				harness.close();
			}
		});

		it("rejects unknown-length chunked overflow and cancels the stream", async () => {
			const harness = await createHarness();
			let canceled = false;
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						controller.enqueue(new Uint8Array(route.limit + 1));
					},
					cancel() {
						canceled = true;
					},
				},
				{ highWaterMark: 0 },
			);
			try {
				const response = await harness.route(requestFor(route.path, body));
				expect(response.status).toBe(413);
				expect(canceled).toBe(true);
				expect(harness.upstreamCalls).toBe(0);
			} finally {
				harness.close();
			}
		});

		it("counts actual bytes when Content-Length is understated", async () => {
			const harness = await createHarness();
			try {
				const response = await harness.route(
					requestFor(route.path, exactBody(route) + " ", {
						headers: { "Content-Length": "1" },
					}),
				);
				expect(response.status).toBe(413);
				expect(harness.upstreamCalls).toBe(0);
			} finally {
				harness.close();
			}
		});

		it("keeps malformed JSON within the cap as a 400", async () => {
			const harness = await createHarness();
			try {
				const response = await harness.route(requestFor(route.path, '{"model":'));
				expect(response.status).toBe(400);
				expect(harness.upstreamCalls).toBe(0);
			} finally {
				harness.close();
			}
		});

		it("keeps a client abort after headers at 499", async () => {
			const harness = await createHarness();
			const controller = new AbortController();
			let bodyStartedResolve: () => void = () => {};
			const bodyStarted = new Promise<void>(resolve => {
				bodyStartedResolve = resolve;
			});
			let canceled = false;
			const body = new ReadableStream<Uint8Array>(
				{
					start(stream) {
						stream.enqueue(new TextEncoder().encode("{"));
					},
					pull() {
						bodyStartedResolve();
						return new Promise<void>(() => {});
					},
					cancel() {
						canceled = true;
					},
				},
				{ highWaterMark: 0 },
			);
			try {
				const pending = harness.route(requestFor(route.path, body, { signal: controller.signal }));
				await bodyStarted;
				controller.abort(new Error("client aborted"));
				const response = await pending;
				expect(response.status).toBe(499);
				expect(canceled).toBe(true);
				expect(harness.upstreamCalls).toBe(0);
			} finally {
				harness.close();
			}
		});
	});
}

describe("auth-gateway image multipart limits", () => {
	it("rejects more than 24 parts before dispatch", async () => {
		const harness = await createHarness();
		const boundary = "parts-boundary";
		// A valid edit plus filler fields: without the part cap it would reach the provider.
		const parts = [
			multipartField("model", imageModel.id),
			multipartField("prompt", "edit"),
			multipartFile("image", "source.png"),
			...Array.from({ length: 22 }, (_, index) => multipartField(`extra-${index}`, "x")),
		];
		try {
			const response = await harness.route(
				requestFor("/v1/images/edits", multipartBody(boundary, parts), {
					headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				}),
			);
			expect(response.status).toBe(400);
			expect(harness.upstreamCalls).toBe(0);
		} finally {
			harness.close();
		}
	});

	it("rejects more than 16 image files before encoding them", async () => {
		const harness = await createHarness();
		const boundary = "files-boundary";
		const parts = [
			multipartField("model", imageModel.id),
			multipartField("prompt", "edit"),
			...Array.from({ length: 17 }, (_, index) =>
				multipartFile(index % 2 === 0 ? "image" : "image[]", `image-${index}.png`),
			),
		];
		try {
			const response = await harness.route(
				requestFor("/v1/images/edits", multipartBody(boundary, parts), {
					headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				}),
			);
			expect(response.status).toBe(400);
			expect(harness.upstreamCalls).toBe(0);
		} finally {
			harness.close();
		}
	});

	it("accepts an image[] file reference for edits", async () => {
		const harness = await createHarness();
		const boundary = "edit-boundary";
		const parts = [
			multipartField("model", imageModel.id),
			multipartField("prompt", "edit the source"),
			multipartFile("image[]", "source.png"),
		];
		try {
			const response = await harness.route(
				requestFor("/v1/images/edits", multipartBody(boundary, parts), {
					headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				}),
			);
			expect(response.status).toBe(200);
			expect(harness.upstreamCalls).toBe(1);
		} finally {
			harness.close();
		}
	});

	// Pads one field so the whole wire body lands exactly on, or one byte past, the multipart cap.
	function cappedEdit(boundary: string, extra: number): Uint8Array {
		const cap = 36 * 1024 * 1024;
		const parts = (pad: string) => [
			multipartField("model", imageModel.id),
			multipartField("prompt", `edit${pad}`),
			multipartFile("image", "source.png"),
		];
		const base = multipartBody(boundary, parts("")).byteLength;
		return multipartBody(boundary, parts(" ".repeat(cap - base + extra)));
	}

	it("accepts a multipart edit exactly at the 36 MiB cap", async () => {
		const harness = await createHarness();
		const boundary = "cap-boundary";
		try {
			const body = cappedEdit(boundary, 0);
			expect(body.byteLength).toBe(36 * 1024 * 1024);
			const response = await harness.route(
				requestFor("/v1/images/edits", body, {
					headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				}),
			);
			expect(response.status).toBe(200);
			expect(harness.upstreamCalls).toBe(1);
		} finally {
			harness.close();
		}
	});

	it("rejects a multipart edit one byte over the 36 MiB cap", async () => {
		const harness = await createHarness();
		const boundary = "cap-boundary";
		try {
			const response = await harness.route(
				requestFor("/v1/images/edits", cappedEdit(boundary, 1), {
					headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				}),
			);
			expect(response.status).toBe(413);
			expect(harness.upstreamCalls).toBe(0);
		} finally {
			harness.close();
		}
	});
});
