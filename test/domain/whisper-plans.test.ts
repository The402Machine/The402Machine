import { describe, expect, it } from "vitest";

import { calculateWhisperExpiry, calculateWhisperSchedule, WHISPER_PLANS } from "../../src/domain/whisper-plans.js";

describe("WHISPER plan catalogue", () => {
	it("scales the unread lifetime and successful read allowance", () => {
		expect(WHISPER_PLANS).toEqual({
			spark: { id: "spark", durationSeconds: 7 * 24 * 60 * 60, readLimit: 1, maxCiphertextBytes: 4_215_276, available: true },
			standard: { id: "standard", durationSeconds: 42 * 24 * 60 * 60, readLimit: 42, maxCiphertextBytes: 4_215_276, available: true },
			long: { id: "long", durationSeconds: 402 * 24 * 60 * 60, readLimit: 402, maxCiphertextBytes: 4_215_276, available: true },
		});
	});

	it("calculates expiry from activation without mutating the input", () => {
		const activatedAt = new Date("2026-07-23T12:00:00.000Z");
		expect(calculateWhisperExpiry("spark", activatedAt).toISOString()).toBe("2026-07-30T12:00:00.000Z");
		expect(calculateWhisperExpiry("standard", activatedAt).toISOString()).toBe("2026-09-03T12:00:00.000Z");
		expect(calculateWhisperExpiry("long", activatedAt).toISOString()).toBe("2027-08-29T12:00:00.000Z");
		expect(activatedAt.toISOString()).toBe("2026-07-23T12:00:00.000Z");
	});

	it("allows every plan to reveal later while preserving at least one hour before its purchase-time expiry", () => {
		const purchasedAt = new Date("2026-07-24T12:00:00.000Z");
		for (const [planId, maximumRevealAt] of [
			["spark", "2026-07-31T11:00:00.000Z"],
			["standard", "2026-09-04T11:00:00.000Z"],
			["long", "2027-08-30T11:00:00.000Z"],
		] as const) {
			const schedule = calculateWhisperSchedule(planId, purchasedAt, new Date(maximumRevealAt));
			expect(schedule.revealAt.toISOString()).toBe(maximumRevealAt);
			expect(schedule.expiresAt.getTime() - schedule.revealAt.getTime()).toBe(60 * 60 * 1_000);
		}
	});

	it("rejects scheduled reveals before purchase or inside the final hour", () => {
		const purchasedAt = new Date("2026-07-24T12:00:00.000Z");
		expect(calculateWhisperSchedule("spark", purchasedAt, new Date("2026-07-24T11:59:59.999Z")).revealAt).toEqual(purchasedAt);
		expect(() => calculateWhisperSchedule("spark", purchasedAt, new Date("2026-07-24T11:58:59.999Z"))).toThrow("reveal date");
		expect(() => calculateWhisperSchedule("spark", purchasedAt, new Date("2026-07-31T11:00:00.001Z"))).toThrow("one hour");
	});
});