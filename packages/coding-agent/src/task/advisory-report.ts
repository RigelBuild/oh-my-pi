import type { ReportInput } from "../extensibility/extensions/task-advisory";

const allowedKeys = { requestId: true, state: true, progress: true, tried: true, blocker: true, nextAction: true };

function shortString(value: unknown): value is string {
	if (typeof value !== "string") return false;
	let characters = 0;
	for (const _ of value) {
		characters++;
		if (characters > 240) return false;
	}
	return true;
}

/** Parse and validate a bound child report without retaining or exposing invalid text. */
export function parseReportInput(body: string, bindingRequestId?: string): ReportInput | undefined {
	if (Buffer.byteLength(body, "utf8") > 4096) return undefined;

	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (Object.keys(value).some(key => !Object.hasOwn(allowedKeys, key))) return undefined;
	if (
		!("state" in value) ||
		!("progress" in value) ||
		!("tried" in value) ||
		!("blocker" in value) ||
		!("nextAction" in value)
	)
		return undefined;

	const requestIdPresent = Object.hasOwn(value, "requestId");
	const requestId: unknown = requestIdPresent ? Reflect.get(value, "requestId") : undefined;
	const { state, progress, blocker, nextAction } = value;
	if (
		(requestIdPresent &&
			(typeof requestId !== "string" ||
				Buffer.byteLength(requestId, "utf8") > 128 ||
				requestId !== bindingRequestId)) ||
		!(state === "progressing" || state === "struggling" || state === "stuck" || state === "waiting") ||
		!shortString(progress) ||
		!shortString(blocker) ||
		!shortString(nextAction)
	)
		return undefined;
	if (blocker.length === 0 && state !== "progressing") return undefined;

	const rawTried = value.tried;
	if (!Array.isArray(rawTried) || rawTried.length > 3) return undefined;
	const tried: string[] = [];
	for (const item of rawTried) {
		if (!shortString(item)) return undefined;
		tried.push(item);
	}

	return {
		...(typeof requestId === "string" ? { requestId } : {}),
		state,
		progress,
		tried,
		blocker,
		nextAction,
	};
}
