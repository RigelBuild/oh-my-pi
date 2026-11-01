import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type { UsageLimit } from "../usage";
import { buildUsageAmount, parseIsoTimestamp, parsePositiveTimestamp, usageStatus } from "./shared";

const API_LIMIT_WINDOWS = [
	{ id: "requests", label: "Requests", unit: "requests" },
	{ id: "input-tokens", label: "Input tokens", unit: "tokens" },
	{ id: "output-tokens", label: "Output tokens", unit: "tokens" },
] as const;

function getHeader(headers: Record<string, string>, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

function parseReset(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const numeric = toNumber(value);
	return numeric === undefined ? parseIsoTimestamp(value) : parsePositiveTimestamp(numeric);
}

/** Parse Anthropic Console API-key request and token windows for one configured model row. */
export function parseAnthropicApiKeyRateLimitHeaders(
	headers: Record<string, string>,
	modelClass: string | undefined,
): UsageLimit[] {
	if (!modelClass) return [];
	const limits: UsageLimit[] = [];
	for (const window of API_LIMIT_WINDOWS) {
		const prefix = `anthropic-ratelimit-${window.id}-`;
		const rawLimit = toNumber(getHeader(headers, `${prefix}limit`));
		const rawRemaining = toNumber(getHeader(headers, `${prefix}remaining`));
		const limit = rawLimit !== undefined && rawLimit > 0 ? rawLimit : undefined;
		const remaining = rawRemaining !== undefined && rawRemaining >= 0 ? rawRemaining : undefined;
		const resetsAt = parseReset(getHeader(headers, `${prefix}reset`));
		if (limit === undefined && remaining === undefined && resetsAt === undefined) continue;
		const used = limit !== undefined && remaining !== undefined ? Math.max(limit - remaining, 0) : undefined;
		const usedFraction = used !== undefined && limit !== undefined ? Math.min(used / limit, 1) : undefined;
		const amount = buildUsageAmount({ used, limit, remaining, usedFraction, unit: window.unit });
		limits.push({
			id: `anthropic:api:${modelClass}:${window.id}`,
			label: `Anthropic API ${window.label}`,
			scope: { provider: "anthropic", modelId: modelClass, windowId: window.id },
			window: { id: window.id, label: window.label, ...(resetsAt !== undefined && { resetsAt }) },
			amount,
			status: amount.usedFraction === undefined ? "unknown" : usageStatus(amount.usedFraction),
		});
	}
	return limits;
}
