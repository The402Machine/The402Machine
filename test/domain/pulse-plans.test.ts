import { describe, expect, it } from "vitest";

import { calculatePulseExpiry, PULSE_PLANS } from "../../src/domain/pulse-plans.js";

describe("PULSE plans", () => {
	it("sells one fixed quota for the complete lifetime instead of a per-minute allowance", () => {
		expect(PULSE_PLANS).toEqual({
			spark: { id: "spark", durationSeconds: 4 * 24 * 60 * 60 + 2 * 60 * 60, heartbeatLimit: 1_202, suggestedCadenceSeconds: 5 * 60, minimumGraceSeconds: 10 * 60, available: true },
			standard: { id: "standard", durationSeconds: 42 * 24 * 60 * 60, heartbeatLimit: 61_402, suggestedCadenceSeconds: 60, minimumGraceSeconds: 2 * 60, available: true },
			long: { id: "long", durationSeconds: 402 * 24 * 60 * 60, heartbeatLimit: 1_740_402, suggestedCadenceSeconds: 20, minimumGraceSeconds: 60, available: true },
		});
	});

	it("leaves a small reserve above the advertised evenly distributed cadence", () => {
		for (const plan of Object.values(PULSE_PLANS)) {
			expect(plan.heartbeatLimit).toBeGreaterThan(Math.ceil(plan.durationSeconds / plan.suggestedCadenceSeconds));
		}
	});

	it("expires from activation after the advertised lifetime", () => {
		const activatedAt = new Date("2026-07-24T10:00:00.000Z");
		expect(calculatePulseExpiry("spark", activatedAt).toISOString()).toBe("2026-07-28T12:00:00.000Z");
		expect(calculatePulseExpiry("standard", activatedAt).toISOString()).toBe("2026-09-04T10:00:00.000Z");
		expect(calculatePulseExpiry("long", activatedAt).toISOString()).toBe("2027-08-30T10:00:00.000Z");
	});
});
