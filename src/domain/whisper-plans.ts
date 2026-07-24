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

export function calculateWhisperSchedule(planId: CatchPlanId, purchasedAt: Date, requestedRevealAt?: Date | null): { revealAt: Date; expiresAt: Date } {
	if (Number.isNaN(purchasedAt.getTime())) throw new Error("A valid purchase date is required");
	const expiresAt = calculateWhisperExpiry(planId, purchasedAt);
	const revealAt = requestedRevealAt === undefined || requestedRevealAt === null ? new Date(purchasedAt) : new Date(requestedRevealAt);
	if (Number.isNaN(revealAt.getTime())) throw new Error("A valid reveal date is required");
	if (requestedRevealAt !== undefined && requestedRevealAt !== null && revealAt.getTime() < purchasedAt.getTime() - 60 * 1_000) throw new Error("A valid reveal date at or after purchase is required");
	if (revealAt.getTime() < purchasedAt.getTime()) revealAt.setTime(purchasedAt.getTime());
	if (expiresAt.getTime() - revealAt.getTime() < 60 * 60 * 1_000) throw new Error("Scheduled reveal must leave at least one hour before expiry");
	return { revealAt, expiresAt };
}
