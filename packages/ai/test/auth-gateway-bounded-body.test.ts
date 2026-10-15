import { describe, expect, it } from "bun:test";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../src/auth-gateway/bounded-body";

const limit = 4;

function request(body: ReadableStream<Uint8Array>, headers?: Record<string, string>): Request {
	return new Request("http://gateway.test/body", { method: "POST", body, headers });
}

describe("auth gateway bounded request bodies", () => {
	it("accepts an exact-limit body and releases the stream lock", async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(limit));
				controller.close();
			},
		});
		const req = request(source);
		expect(await readBoundedRequestBody(req, limit)).toHaveLength(limit);
		expect(req.body?.locked).toBe(false);
	});

	it("cancels an understated over-limit stream before retaining the chunk", async () => {
		let canceled = false;
		const req = request(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(limit + 1));
				},
				cancel() {
					canceled = true;
				},
			}),
			{ "Content-Length": "1" },
		);
		await expect(readBoundedRequestBody(req, limit)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
		expect(canceled).toBe(true);
		expect(req.body?.locked).toBe(false);
	});

	it("still reports overflow when cancelling the stream fails", async () => {
		const req = request(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(limit + 1));
				},
				cancel() {
					throw new Error("cancel failed");
				},
			}),
		);
		await expect(readBoundedRequestBody(req, limit)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
		expect(req.body?.locked).toBe(false);
	});

	it("rejects declared oversize without reading the body", async () => {
		let read = false;
		const req = request(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					read = true;
					controller.enqueue(new Uint8Array([1]));
				},
			}),
			{ "Content-Length": String(limit + 1) },
		);
		await expect(readBoundedRequestBody(req, limit)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
		expect(read).toBe(false);
		expect(req.body?.locked).toBe(false);
	});

	it("keeps an aborted partial stream distinguishable from overflow", async () => {
		const controller = new AbortController();
		let cancelSeenResolve: () => void = () => {};
		const cancelSeen = new Promise<void>(resolve => {
			cancelSeenResolve = resolve;
		});
		const req = request(
			new ReadableStream<Uint8Array>({
				start(stream) {
					stream.enqueue(new Uint8Array([1]));
				},
				pull() {},
				cancel() {
					cancelSeenResolve();
				},
			}),
		);
		const read = readBoundedRequestBody(req, limit, controller.signal);
		await Promise.resolve();
		controller.abort(new Error("client aborted"));
		await cancelSeen;
		await expect(read).rejects.toThrow("client aborted");
		expect(req.body?.locked).toBe(false);
	});
});
