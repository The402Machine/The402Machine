import type { CatchPlanId } from "./catch-plans.js";

export interface PulsePlan {
	readonly id: CatchPlanId;
	readonly durationSeconds: number;
	readonly heartbeatLimit: number;
	readonly suggestedCadenceSeconds: number;
	readonly minimumGraceSeconds: number;
	readonly available: boolean;
}

export const PULSE_PLANS: Readonly<Record<CatchPlanId, PulsePlan>> = {
	spark: { id: "spark", durationSeconds: 4 * 24 * 60 * 60 + 2 * 60 * 60, heartbeatLimit: 1_202, suggestedCadenceSeconds: 5 * 60, minimumGraceSeconds: 10 * 60, available: true },
	standard: { id: "standard", durationSeconds: 42 * 24 * 60 * 60, heartbeatLimit: 61_402, suggestedCadenceSeconds: 60, minimumGraceSeconds: 2 * 60, available: true },
	long: { id: "long", durationSeconds: 402 * 24 * 60 * 60, heartbeatLimit: 1_740_402, suggestedCadenceSeconds: 20, minimumGraceSeconds: 60, available: true },
};

export function calculatePulseExpiry(planId: CatchPlanId, activatedAt: Date): Date {
	if (Number.isNaN(activatedAt.getTime())) throw new Error("A valid activation date is required");
	return new Date(activatedAt.getTime() + PULSE_PLANS[planId].durationSeconds * 1_000);
}

export function validPulseSchedule(planId: CatchPlanId, expectedIntervalSeconds: number, graceSeconds: number): boolean {
	const plan = PULSE_PLANS[planId];
	return Number.isInteger(expectedIntervalSeconds) && expectedIntervalSeconds >= plan.suggestedCadenceSeconds && expectedIntervalSeconds <= 7 * 24 * 60 * 60 &&
		Number.isInteger(graceSeconds) && graceSeconds >= plan.minimumGraceSeconds && graceSeconds <= 7 * 24 * 60 * 60;
}
