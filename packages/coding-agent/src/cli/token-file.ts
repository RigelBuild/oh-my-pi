/**
 * Bearer-token file helpers shared by the auth broker and auth gateway CLIs.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, withFileLock } from "@oh-my-pi/pi-utils";

/** Read a token file; `null` when it is missing or blank. */
export async function readTokenFile(file: string): Promise<string | null> {
	try {
		const raw = await fs.readFile(file, "utf8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Replace the token at `file` atomically; the caller holds the file lock. */
async function publishTokenFile(file: string, token: string): Promise<void> {
	const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temp, token, { mode: 0o600 });
		try {
			await fs.chmod(temp, 0o600);
		} catch {
			// Best-effort (e.g. Windows).
		}
		await fs.rename(temp, file);
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/**
 * Write a token file readable only by the current user. Writers share a
 * cross-process lock and replace the file atomically, so readers never see a partial token.
 */
export async function writeTokenFile(file: string, token: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await withFileLock(file, () => publishTokenFile(file, token));
}

/**
 * Read the token at `file`, or mint one. The check-and-write runs under the
 * writers' lock, so concurrent first callers and `--regenerate` agree on the token.
 */
export async function ensureTokenFile(file: string): Promise<string> {
	const existing = await readTokenFile(file);
	if (existing) return existing;
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	return withFileLock(file, async () => {
		const winner = await readTokenFile(file);
		if (winner) return winner;
		const token = generateToken();
		await publishTokenFile(file, token);
		return token;
	});
}

/** Generate a random URL-safe bearer token. */
export function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}
