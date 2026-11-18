import { describe, expect, test } from "bun:test";
import { extractProviderRetryHint } from "../src/utils/retry-after";

const PROVIDER = "cc-switch-zhipu-glm";
const CODING_PLAN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const RESET_WAIT_MS = 82 * 60_000;
const HOUR_MS = 60 * 60 * 1000;

describe("extractProviderRetryHint: custom Zhipu Coding Plan reset offset", () => {
	// A naive Beijing wall stamp ~82 min out; read as UTC it adds ~8h.
	const resetStamp = new Date(Date.now() + RESET_WAIT_MS + 8 * HOUR_MS).toISOString().slice(0, 19).replace("T", " ");
	const message = `429 已达到 5 小时的使用上限，您的限额将在 ${resetStamp} 重置. (type=1308)`;

	test("applies the Beijing offset when the endpoint is passed", () => {
		const hintMs = extractProviderRetryHint(PROVIDER, message, CODING_PLAN_BASE_URL);
		expect(hintMs).toBeDefined();
		expect(hintMs!).toBeGreaterThan(RESET_WAIT_MS - 60_000);
		expect(hintMs!).toBeLessThan(RESET_WAIT_MS + 60_000);
	});

	test("without the endpoint the same stamp reads eight hours late", () => {
		const hintMs = extractProviderRetryHint(PROVIDER, message);
		expect(hintMs).toBeDefined();
		expect(hintMs!).toBeGreaterThan(7 * HOUR_MS);
	});
});
