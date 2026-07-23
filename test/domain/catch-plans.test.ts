import { describe, expect, it } from "vitest";

import { CATCH_PLANS, calculatePlanExpiry } from "../../src/domain/catch-plans.js";

describe("CATCH plan catalogue", () => {
	it("defines the public Spark plan limits and duration", () => {
		expect(CATCH_PLANS.spark).toEqual({
			id: "spark",
			duration: { kind: "fixed", seconds: 14_520 },
			requestLimit: 402,
			storageLimitBytes: 2 * 1024 * 1024,
			maxBytesPerRequest: 64 * 1024,
			available: true,
		});
	});

	it("defines the public Standard plan limits and duration", () => {
		expect(CATCH_PLANS.standard).toEqual({
			id: "standard",
			duration: { kind: "fixed", seconds: 2_592_000 },
			requestLimit: 4_020,
			storageLimitBytes: 20 * 1024 * 1024,
			maxBytesPerRequest: 256 * 1024,
			available: true,
		});
	});

	it("defines Long as a purchasable calendar-duration plan", () => {
		expect(CATCH_PLANS.long).toEqual({
			id: "long",
			duration: { kind: "calendar", months: 4, days: 2 },
			requestLimit: 40_200,
			storageLimitBytes: 200 * 1024 * 1024,
			maxBytesPerRequest: 1024 * 1024,
			available: true,
		});
	});
});

describe("CATCH plan expiry", () => {
	it("rejects an invalid activation date", () => {
		expect(() => calculatePlanExpiry("spark", new Date("not-a-date"))).toThrow(
			"A valid activation date is required",
		);
	});

	it("calculates fixed-duration expiry without mutating activation time", () => {
		const activatedAt = new Date("2026-07-23T00:00:00.000Z");

		expect(calculatePlanExpiry("spark", activatedAt).toISOString()).toBe("2026-07-23T04:02:00.000Z");
		expect(calculatePlanExpiry("standard", activatedAt).toISOString()).toBe("2026-08-22T00:00:00.000Z");
		expect(activatedAt.toISOString()).toBe("2026-07-23T00:00:00.000Z");
	});

	it("calculates Long expiry with UTC calendar arithmetic", () => {
		expect(calculatePlanExpiry("long", new Date("2026-07-23T00:00:00.000Z")).toISOString()).toBe(
			"2026-11-25T00:00:00.000Z",
		);
	});

	it("clamps Long calendar month addition at the end of a month", () => {
		expect(calculatePlanExpiry("long", new Date("2026-10-31T12:34:56.000Z")).toISOString()).toBe(
			"2027-03-02T12:34:56.000Z",
		);
	});

	it("clamps Long across leap February while preserving UTC time", () => {
		expect(calculatePlanExpiry("long", new Date("2023-10-31T12:34:56.789Z")).toISOString()).toBe(
			"2024-03-02T12:34:56.789Z",
		);
	});
});
