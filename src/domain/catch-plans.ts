export type CatchPlanId = "spark" | "standard" | "long";

export type CatchPlanDuration =
	| { readonly kind: "fixed"; readonly seconds: number }
	| { readonly kind: "calendar"; readonly months: number; readonly days: number };

export interface CatchPlan {
	readonly id: CatchPlanId;
	readonly duration: CatchPlanDuration;
	readonly requestLimit: number;
	readonly storageLimitBytes: number;
	readonly maxBytesPerRequest: number;
	readonly available: boolean;
}

export const CATCH_PLANS: Readonly<Record<CatchPlanId, CatchPlan>> = {
	spark: {
		id: "spark",
		duration: { kind: "fixed", seconds: 14_520 },
		requestLimit: 402,
		storageLimitBytes: 2 * 1024 * 1024,
		maxBytesPerRequest: 16 * 1024,
		available: true,
	},
	standard: {
		id: "standard",
		duration: { kind: "fixed", seconds: 2_592_000 },
		requestLimit: 4_020,
		storageLimitBytes: 20 * 1024 * 1024,
		maxBytesPerRequest: 16 * 1024,
		available: true,
	},
	long: {
		id: "long",
		duration: { kind: "calendar", months: 4, days: 2 },
		requestLimit: 40_200,
		storageLimitBytes: 200 * 1024 * 1024,
		maxBytesPerRequest: 16 * 1024,
		available: true,
	},
};

export function calculatePlanExpiry(planId: CatchPlanId, activatedAt: Date): Date {
	if (Number.isNaN(activatedAt.getTime())) {
		throw new Error("A valid activation date is required");
	}

	const duration = CATCH_PLANS[planId].duration;

	if (duration.kind === "fixed") {
		return new Date(activatedAt.getTime() + duration.seconds * 1_000);
	}

	return addUtcCalendarDuration(activatedAt, duration.months, duration.days);
}

function addUtcCalendarDuration(activatedAt: Date, months: number, days: number): Date {
	const expiry = new Date(activatedAt.getTime());
	const originalDay = expiry.getUTCDate();

	expiry.setUTCDate(1);
	expiry.setUTCMonth(expiry.getUTCMonth() + months);
	expiry.setUTCDate(Math.min(originalDay, daysInUtcMonth(expiry.getUTCFullYear(), expiry.getUTCMonth())));
	expiry.setUTCDate(expiry.getUTCDate() + days);

	return expiry;
}

function daysInUtcMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
