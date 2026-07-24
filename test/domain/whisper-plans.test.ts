import { describe, expect, it } from "vitest";

import { calculateWhisperExpiry, WHISPER_PLANS } from "../../src/domain/whisper-plans.js";

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
});