export class RequestBodyTooLargeError extends Error {
	constructor() {
		super("Request payload exceeds the configured limit");
		this.name = "RequestBodyTooLargeError";
	}
}

export async function readBoundedRequestBody(
	req: Request,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	// Content-Length is only an early hint; chunks remain the source of truth.
	if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
	const length = req.headers.get("content-length");
	if (length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes)) {
		await req.body?.cancel().catch(() => {});
		throw new RequestBodyTooLargeError();
	}
	const reader = req.body?.getReader();
	if (!reader) return new Uint8Array();

	// Copy into one doubling buffer: keeping each chunk costs per-chunk overhead that a
	// client controls by splitting the body into tiny chunks.
	let buffer = new Uint8Array(0);
	let total = 0;
	let complete = false;
	const onAbort = (): void => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
			if (done) {
				complete = true;
				break;
			}
			if (value.byteLength > maxBytes - total) {
				// A failing cancel must not turn the 413 into a malformed-body 400.
				await reader.cancel().catch(() => {});
				throw new RequestBodyTooLargeError();
			}
			if (total + value.byteLength > buffer.byteLength) {
				const size = Math.max(64 * 1024, buffer.byteLength * 2, total + value.byteLength);
				const grown = new Uint8Array(Math.min(maxBytes, size));
				grown.set(buffer.subarray(0, total));
				buffer = grown;
			}
			buffer.set(value, total);
			total += value.byteLength;
		}
		return buffer.subarray(0, total);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!complete) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
