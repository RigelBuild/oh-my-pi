import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	clampProviderContextImageCount,
	clampProviderContextImages,
	dropUnreadableContextImages,
	PROVIDER_IMAGE_COUNT_DECODE_SLACK,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const ANTHROPIC_MODEL = buildModel({
	id: "claude-opus-4-8",
	name: "claude-opus-4-8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});

/**
 * A minimal but fully typed assistant turn. Only `role` and `content` matter to
 * the clamp; the provider bookkeeping fields are required by `AssistantMessage`
 * and carry no meaning for these assertions.
 */
function assistantTurn(content: ImageContent[], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: ANTHROPIC_MODEL.api,
		provider: ANTHROPIC_MODEL.provider,
		model: ANTHROPIC_MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

/**
 * Images in the request the provider actually receives, counted by converting
 * the context through the real Anthropic-messages transform. This is the
 * population the per-request image cap applies to; anything the transform drops
 * on the way out never consumed it.
 */
function wireImageCount(context: Context, model: Model<"anthropic-messages">): number {
	let count = 0;
	for (const param of convertAnthropicMessages(context.messages, model, false)) {
		if (typeof param.content === "string") continue;
		for (const block of param.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

/**
 * A decodable PNG whose encoded size tracks its raster size.
 *
 * Built by hand rather than upscaled from a seed: `Bun.Image` re-encodes, and a
 * replicated or flat raster compresses to a few KB, far under any byte budget.
 * Deflate "stored" blocks (BTYPE=00) keep the IDAT stream the size of the raw
 * scanlines, so a 1100px square lands near 4.8 MB of base64.
 */
function largeDecodablePng(edge: number): Uint8Array {
	const raw = new Uint8Array(edge * (1 + edge * 3));
	for (let y = 0; y < edge; y++) {
		const row = y * (1 + edge * 3);
		raw[row] = 0; // filter: None
		for (let x = 0; x < edge * 3; x++) raw[row + 1 + x] = (y * 7 + x * 13) % 256;
	}
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const body = new Uint8Array(4 + data.length);
		body.set(new TextEncoder().encode(type), 0);
		body.set(data, 4);
		const out = new Uint8Array(4 + body.length + 4);
		new DataView(out.buffer).setUint32(0, data.length);
		out.set(body, 4);
		new DataView(out.buffer).setUint32(4 + body.length, crc32(body));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, edge);
	view.setUint32(4, edge);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlibStored(raw)),
		chunk("IEND", new Uint8Array(0)),
	];
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const png = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	return png;
}

/** zlib stream of `data` in uncompressed deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
	const MAX = 65535;
	const blocks = Math.ceil(data.length / MAX);
	const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
	out[0] = 0x78;
	out[1] = 0x01;
	let at = 2;
	for (let start = 0; start < data.length; start += MAX) {
		const slice = data.subarray(start, Math.min(start + MAX, data.length));
		out[at++] = start + MAX >= data.length ? 1 : 0;
		out[at++] = slice.length & 0xff;
		out[at++] = (slice.length >> 8) & 0xff;
		out[at++] = ~slice.length & 0xff;
		out[at++] = (~slice.length >> 8) & 0xff;
		out.set(slice, at);
		at += slice.length;
	}
	new DataView(out.buffer).setUint32(at, adler32(data));
	return out.subarray(0, at + 4);
}

function adler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of data) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 21}`));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("invalidates native replay payloads when user or developer images are clamped", () => {
		const userPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "user-native" }] }],
		};
		const developerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "developer", content: [{ type: "input_image", image_url: "dev-native" }] }],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], providerPayload: userPayload, timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], providerPayload: developerPayload, timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const clampedUser = clamped.messages[0];
		const clampedDeveloper = clamped.messages[1];
		const originalUser = context.messages[0];
		const originalDeveloper = context.messages[1];

		expect(clampedUser?.role).toBe("user");
		expect(clampedDeveloper?.role).toBe("developer");
		if (
			clampedUser?.role !== "user" ||
			clampedDeveloper?.role !== "developer" ||
			originalUser?.role !== "user" ||
			originalDeveloper?.role !== "developer"
		) {
			throw new Error("Expected clamped user and developer messages");
		}
		expect(clampedUser.providerPayload).toBeUndefined();
		expect(clampedDeveloper.providerPayload).toBeUndefined();
		expect(originalUser.providerPayload).toBe(userPayload);
		expect(originalDeveloper.providerPayload).toBe(developerPayload);
		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `kept-image-${index}`));
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});

	it("drops oldest images when total image bytes exceed the provider byte budget", () => {
		const byteBudget = providerImageByteBudget("anthropic");
		const chunk = Math.ceil(byteBudget * 0.4);
		const frame = (tag: string) => image(tag + "x".repeat(chunk - 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [frame("0")], timestamp: 0 },
				{ role: "user", content: [frame("1")], timestamp: 1 },
				{ role: "user", content: [frame("2")], timestamp: 2 },
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const remaining = imageData(clamped);
		const totalBytes = remaining.reduce((sum, data) => sum + data.length, 0);

		// 3 frames sit far under Anthropic's image COUNT cap (90) yet total ~1.2x
		// the byte budget; the oldest frame drops so the payload fits.
		expect(totalBytes).toBeLessThanOrEqual(byteBudget);
		expect(remaining.map(data => data[0])).toEqual(["1", "2"]);
	});

	it("still relieves byte pressure when the count cap binds at the same time", () => {
		// The case a single shared drop counter gets wrong: an old reference-backed
		// image satisfies the count cap while relieving zero bytes, so collapsing
		// the two budgets with max() drops only the reference and leaves the
		// request over the byte budget -- still a 413.
		const countBudget = providerImageBudget("anthropic");
		const byteBudget = providerImageByteBudget("anthropic");
		const referenced = { ...image("old-reference"), url: "https://images.test/old.png" };
		const oversized = image("z".repeat(byteBudget + 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [referenced], timestamp: 0 },
				{ role: "user", content: [oversized], timestamp: 1 },
				...Array.from({ length: countBudget - 1 }, (_, index) => ({
					role: "user" as const,
					content: [image(`small-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		const survivingInlineBytes = clamped.messages
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.filter((part): part is ImageContent => part.type === "image" && part.url === undefined)
			.reduce((sum, part) => sum + part.data.length, 0);
		expect(survivingInlineBytes).toBeLessThanOrEqual(byteBudget);
	});

	it("counts reference-backed images toward the per-request image cap", () => {
		// The count cap is a provider limit on image PARTS, which a reference
		// consumes just like inline bytes. Counting only inline images would let a
		// context of references sail past the cap.
		const countBudget = providerImageBudget("anthropic");
		const referenced = (tag: string) => ({ ...image(tag), url: `https://images.test/${tag}.png` });
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: countBudget + 3 }, (_, index) => ({
				role: "user" as const,
				content: [referenced(`frame-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		const remaining = clamped.messages.filter(message =>
			Array.isArray(message.content) ? message.content.some(part => part.type === "image") : false,
		).length;
		expect(remaining).toBe(countBudget);
	});

	it("drops inline images, not preceding references, when only bytes are over budget", () => {
		// A reference carries no wire bytes, so dropping it cannot relieve byte
		// pressure: the oversized inline image would survive and the request would
		// still be too large, having lost context for nothing.
		const byteBudget = providerImageByteBudget("anthropic");
		const referenced = { ...image("kept-reference"), url: "https://images.test/kept.png" };
		const oversizedInline = image("y".repeat(byteBudget + 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [referenced], timestamp: 0 },
				{ role: "user", content: [oversizedInline], timestamp: 1 },
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		expect(clamped.messages[0]?.content).toEqual([referenced]);
		expect(clamped.messages[1]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("ignores URL-backed images for the byte budget", () => {
		// Strictly over the limit: `imageDropCountForBytes` drops only while
		// `total > byteLimit`, so a payload of exactly the budget never drops and
		// would pass whether or not URL-backed images are excluded.
		const byteBudget = providerImageByteBudget("anthropic");
		const oversized = image("x".repeat(byteBudget + 1));
		const referenced = { ...oversized, url: "https://images.test/frame.png" };
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [referenced], timestamp: 0 }],
		};

		expect(clampProviderContextImages(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("keeps image-only user and developer turns meaningful when dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(clamped.messages[1]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("drops oversized tool-result images when only the byte budget is exceeded", () => {
		// The count cap is satisfied (2 images, cap 90) but the summed inline
		// bytes are ~1.2x the byte budget. A tool-result path guarded on the
		// count budget alone would leave the oversized base64 on the wire.
		const byteBudget = providerImageByteBudget("anthropic");
		const chunk = Math.ceil(byteBudget * 0.6);
		const frame = (tag: string) => image(tag + "x".repeat(chunk - 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "read",
					content: [frame("0")],
					isError: false,
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [frame("1")],
					isError: false,
					timestamp: 1,
				},
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const remaining = imageData(clamped);

		expect(remaining.reduce((sum, data) => sum + data.length, 0)).toBeLessThanOrEqual(byteBudget);
		expect(remaining.map(data => data[0])).toEqual(["1"]);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("does not charge assistant display images against the byte budget", () => {
		// `transform-messages.ts` drops every assistant image block
		// unconditionally, so its base64 never reaches the wire. Charging it here
		// evicts a live image in its place: an old oversized generated artifact
		// plus one small current screenshot busts the budget on paper, and since
		// assistant turns are never themselves clamped the small user image is
		// what gets dropped — leaving the request no smaller.
		const byteBudget = providerImageByteBudget("anthropic");
		const huge = image("a".repeat(Math.ceil(byteBudget * 1.2)));
		const small = image("s".repeat(1024));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [assistantTurn([huge], 0), { role: "user", content: [small], timestamp: 1 }],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		// The user image survives: only wire-bound bytes constrain the budget.
		expect(imageData(clamped).map(data => data[0])).toEqual(["a", "s"]);
		expect(clamped).toBe(context);
	});

	it("keeps every image when total image bytes fit the provider byte budget", () => {
		const small = image("x".repeat(1024));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [small, small, small], timestamp: 0 }],
		};

		expect(clampProviderContextImages(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("does not spend the byte budget on an image the unreadable pass will drop anyway", async () => {
		// `sdk.ts` runs this clamp BEFORE `dropUnreadableContextImages` (`:3454`
		// then `:3459`), so a corrupt newest image was charged against the byte
		// budget, the oldest-first clamp evicted the VALID older image to make
		// room, and the unreadable pass then replaced the corrupt one too — the
		// request lost every image although the readable one fit on its own.
		const budget = providerImageByteBudget(ANTHROPIC_MODEL.provider);

		// A REAL decodable PNG, over half the budget. The unreadable check decodes
		// in full, so filler bytes would be dropped as corrupt and could not stand
		// in for the valid image; and a solid colour re-compresses to a few KB, so
		// the raster carries per-pixel variation and is stored with deflate level
		// 0 to keep the encoded size near the raster size.
		const valid = Buffer.from(largeDecodablePng(1100)).toString("base64");
		if (valid.length <= budget * 0.5) throw new Error("fixture image cannot bust the budget");
		// Undecodable base64 of comparable size: `unreadableImageReason` rejects it.
		const corrupt = "!".repeat(valid.length);

		// User turns, not assistant: assistant images count toward the budget but
		// are never dropped by either pass, so they cannot express this bug.
		const context: Context = {
			messages: [
				{ role: "user", content: [image(valid)], timestamp: 1 },
				{ role: "user", content: [image(corrupt)], timestamp: 2 },
			],
		};

		// Readable-first — the order the fix establishes.
		const readableFirst = await dropUnreadableContextImages(context, ANTHROPIC_MODEL);
		expect(imageData(clampProviderContextImages(readableFirst, ANTHROPIC_MODEL))).toEqual([valid]);

		// Clamp-first — the order `sdk.ts` used — evicts the valid image to make
		// room for bytes that are about to be thrown away, leaving none.
		const clampFirst = await dropUnreadableContextImages(
			clampProviderContextImages(context, ANTHROPIC_MODEL),
			ANTHROPIC_MODEL,
		);
		expect(imageData(clampFirst)).toEqual([]);
	});
});

describe("count cap ahead of the decode pass", () => {
	it("drops over-cap images before the unreadable pass can decode them", async () => {
		// The count cap for `umans` is 10, and this pass admits a slack multiple
		// of it. A history well past that window has the excess discarded
		// regardless of content, so decoding it (a full decode each, behind a
		// cache a longer history evicts every request) is pure waste.
		const admissible = providerImageBudget(UMANS_MODEL.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const total = admissible + 20;
		// Undecodable bytes: if the count clamp runs FIRST these never reach
		// `dropUnreadableContextImages`, so they stay verbatim image blocks. Run
		// after, and the decode pass rewrites each survivor to an omission notice.
		const context: Context = {
			messages: Array.from({ length: total }, (_, index) => ({
				role: "user" as const,
				content: [image(`!${"!".repeat(index)}`)],
				timestamp: index,
			})),
		};

		const counted = clampProviderContextImageCount(context, UMANS_MODEL);

		// Only the newest `admissible` images survive, and they are still images:
		// the count pass never decodes, so it cannot have consulted readability.
		expect(imageData(counted)).toEqual(
			Array.from({ length: admissible }, (_, index) => `!${"!".repeat(total - admissible + index)}`),
		);
		// Every discarded turn keeps its conversational position.
		expect(counted.messages).toHaveLength(total);
		expect(counted.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("leaves a context already within the count cap untouched", () => {
		const context: Context = {
			messages: [{ role: "user", content: [image("a"), image("b")], timestamp: 0 }],
		};

		expect(clampProviderContextImageCount(context, UMANS_MODEL)).toBe(context);
	});

	it("ignores the byte budget so normalization can still rewrite sizes", () => {
		// A single image far over the BYTE budget but within the count cap must
		// survive this pass: byte counts are not final until normalization has
		// run, so charging them here would evict an image that may shrink.
		const huge = image("x".repeat(providerImageByteBudget("anthropic") * 2));
		const context: Context = {
			messages: [{ role: "user", content: [huge], timestamp: 0 }],
		};

		expect(clampProviderContextImageCount(context, ANTHROPIC_MODEL)).toBe(context);
		// The byte-aware clamp, which runs later, is what drops it.
		expect(imageData(clampProviderContextImages(context, ANTHROPIC_MODEL))).toEqual([]);
	});

	it("never spends the cap on assistant display images, which the wire population excludes", () => {
		// An assistant image is a display artifact: `transformMessages` drops
		// every one of them before a request is built, so it cannot consume the
		// provider's per-request image cap. Charging it anyway evicted live user
		// images to make room for artifacts that were never going to be sent.
		const admissible = providerImageBudget(UMANS_MODEL.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const userImages = Array.from({ length: 5 }, (_, index) => `user-${index}`);
		const context: Context = {
			messages: [
				assistantTurn(
					Array.from({ length: admissible }, (_, index) => image(`assistant-${index}`)),
					0,
				),
				{ role: "user", content: userImages.map(image), timestamp: 1 },
			],
		};

		// The externally observable contract: only the 5 user images are images
		// on the wire, however many the assistant turn carries in the transcript.
		expect(wireImageCount(context, UMANS_MODEL)).toBe(5);

		// So the clamp has nothing to do, and every user image survives.
		const clamped = clampProviderContextImageCount(context, UMANS_MODEL);
		expect(imageData(clamped)).toEqual([
			...Array.from({ length: admissible }, (_, index) => `assistant-${index}`),
			...userImages,
		]);
		expect(wireImageCount(clamped, UMANS_MODEL)).toBe(5);
	});

	it("still clamps once the wire-bound images alone exceed the cap", () => {
		// The exclusion above is not a licence to overshoot: user images are wire
		// images, so an assistant turn beside them changes nothing about their
		// own eviction. `budget + 1` survive the count pass (cap plus one slack
		// multiple), and the wire sees exactly that many.
		const budget = providerImageBudget(UMANS_MODEL.provider);
		const admissible = budget * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const total = admissible + 4;
		const context: Context = {
			messages: [
				assistantTurn([image("assistant-0")], 0),
				...Array.from({ length: total }, (_, index) => ({
					role: "user" as const,
					content: [image(`user-${index}`)],
					timestamp: index + 1,
				})),
			],
		};

		const clamped = clampProviderContextImageCount(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual([
			"assistant-0",
			...Array.from({ length: admissible }, (_, index) => `user-${index + 4}`),
		]);
		expect(wireImageCount(clamped, UMANS_MODEL)).toBe(admissible);
		// The byte-aware clamp that runs last brings the wire down to the cap.
		expect(wireImageCount(clampProviderContextImages(clamped, UMANS_MODEL), UMANS_MODEL)).toBe(budget);
	});
});
