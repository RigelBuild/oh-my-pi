import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgAutolearnCaptureRole } from "./settings";

/**
 * The model and thinking level the capture runs on, from `autolearn.captureRole`.
 *
 * - No role configured: `undefined`, so the capture keeps the seat's model.
 * - Role not configured, or its model unavailable: `null`, so the capture is skipped.
 *   It never falls back to the seat's model.
 * - Otherwise the role's model and its thinking level, or `fallbackLevel` when the role names none.
 */
export function resolveAutolearnCaptureTarget(
	settings: Settings,
	availableModels: Model<Api>[],
	fallbackLevel: Effort | undefined,
): { model: Model<Api>; thinkingLevel: Effort | undefined } | null | undefined {
	const role = cfgAutolearnCaptureRole.get(settings)?.trim();
	if (!role) return undefined;
	const roleValue = settings.getModelRole(role);
	if (!roleValue) {
		logger.warn("auto-learn capture skipped: autolearn.captureRole is not a configured role", { role });
		return null;
	}
	const resolved = resolveModelRoleValue(roleValue, availableModels, { settings });
	if (!resolved.model) {
		logger.warn("auto-learn capture skipped: autolearn.captureRole model is unavailable", {
			role,
			warning: resolved.warning,
		});
		return null;
	}
	return {
		model: resolved.model,
		thinkingLevel: THINKING_EFFORTS.find(effort => effort === resolved.thinkingLevel) ?? fallbackLevel,
	};
}
