/** Splits `files` into `count` contiguous groups whose sizes differ by at most one. */
export function splitIntoChunks<T>(files: T[], count: number): T[][] {
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(`Invalid chunk count ${count}`);
	}
	const chunks: T[][] = [];
	let start = 0;
	for (let i = 0; i < count; i++) {
		const end = start + Math.floor(files.length / count) + (i < files.length % count ? 1 : 0);
		if (end > start) chunks.push(files.slice(start, end));
		start = end;
	}
	return chunks;
}
