/**
 * Bearer-token file helpers shared by the auth broker and auth gateway CLIs.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

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

/** Write a token file readable only by the current user. */
export async function writeTokenFile(file: string, token: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/**
 * Read the token at `file`, or mint one. The token is written to a temp file
 * and hard-linked into place, so the publish is exclusive and never half-written:
 * concurrent first callers all return the winner's token.
 */
export async function ensureTokenFile(file: string): Promise<string> {
	const existing = await readTokenFile(file);
	if (existing) return existing;
	const token = generateToken();
	const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await writeTokenFile(temp, token);
	try {
		await fs.link(temp, file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const winner = await readTokenFile(file);
		// A blank file left by an older writer holds no token; replace it.
		if (!winner) await fs.rename(temp, file);
		return winner ?? token;
	} finally {
		await fs.rm(temp, { force: true });
	}
	return token;
}

/** Generate a random URL-safe bearer token. */
export function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}
