import type { CatchPlanId } from "./catch-plans.js";

export const MAX_WHISPER_CIPHERTEXT_BYTES = 4_215_276;

export interface WhisperPlan {
	readonly id: CatchPlanId;
	readonly durationSeconds: number;
	readonly readLimit: number;
	readonly maxCiphertextBytes: number;
	readonly available: boolean;
}

export const WHISPER_PLANS: Readonly<Record<CatchPlanId, WhisperPlan>> = {
	spark: { id: "spark", durationSeconds: 7 * 24 * 60 * 60, readLimit: 1, maxCiphertextBytes: MAX_WHISPER_CIPHERTEXT_BYTES, available: true },
	standard: { id: "standard", durationSeconds: 42 * 24 * 60 * 60, readLimit: 42, maxCiphertextBytes: MAX_WHISPER_CIPHERTEXT_BYTES, available: true },
	long: { id: "long", durationSeconds: 402 * 24 * 60 * 60, readLimit: 402, maxCiphertextBytes: MAX_WHISPER_CIPHERTEXT_BYTES, available: true },
};

export function calculateWhisperExpiry(planId: CatchPlanId, activatedAt: Date): Date {
	if (Number.isNaN(activatedAt.getTime())) throw new Error("A valid activation date is required");
	return new Date(activatedAt.getTime() + WHISPER_PLANS[planId].durationSeconds * 1_000);
}
