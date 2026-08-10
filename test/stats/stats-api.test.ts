import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("public stats", () => {
	it("serves privacy-safe aggregates with a short public cache", async () => {
		const stats = {
			pageViews: 1_402,
			viewsToday: 42,
			viewsLast7Days: 402,
			quotesIssued: 8,
			paidPayments: 5,
			dispensedResources: 4,
			receivedSats: 570,
			periods: {
				all: { pageViews: 1_402, quotesIssued: 8, paidPayments: 5, dispensedResources: 4, receivedSats: 570 },
				today: { pageViews: 42, quotesIssued: 3, paidPayments: 2, dispensedResources: 2, receivedSats: 402 },
				last7Days: { pageViews: 402, quotesIssued: 6, paidPayments: 4, dispensedResources: 3, receivedSats: 528 },
				last30Days: { pageViews: 610, quotesIssued: 7, paidPayments: 4, dispensedResources: 3, receivedSats: 528 },
			},
			funnel: { trackingStartedOn: "2026-08-10", pageViews: 1_402, quotesIssued: 8, paidPayments: 5, dispensedResources: 4, visitToQuotePercent: 0.6, quoteToPaidPercent: 62.5, paidToDispensedPercent: 80 },
			activityLast30Days: [{ day: "2026-08-10", pageViews: 42, quotesIssued: 3, paidPayments: 2, dispensedResources: 2 }],
			byProduct: {
				catch: { quotesIssued: 3, paidPayments: 2, dispensedResources: 2, receivedSats: 84, byPlan: emptyPlans({ spark: { quotesIssued: 3, paidPayments: 2, dispensedResources: 2, receivedSats: 84 } }) },
				whisper: { quotesIssued: 3, paidPayments: 2, dispensedResources: 1, receivedSats: 444, byPlan: emptyPlans({ standard: { quotesIssued: 3, paidPayments: 2, dispensedResources: 1, receivedSats: 444 } }) },
				pulse: { quotesIssued: 2, paidPayments: 1, dispensedResources: 1, receivedSats: 42, byPlan: emptyPlans({ long: { quotesIssued: 2, paidPayments: 1, dispensedResources: 1, receivedSats: 42 } }) },
			},
		};
		const app = buildApp({ stats: { getPublicStats: () => Promise.resolve(stats) } });
		const response = await app.inject({ method: "GET", url: "/api/stats" });
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("public, max-age=30");
		expect(response.json()).toEqual(stats);
		expect(response.body).not.toMatch(/order|invoice|token|publicId|ip/iu);
		await app.close();
	});

	it("records public HTML visits without retaining request identity", async () => {
		const viewedPaths: string[] = [];
		const app = buildApp({ stats: {
			getPublicStats: () => Promise.resolve(emptyStats()),
			recordPageView: (path) => { viewedPaths.push(path); return Promise.resolve(); },
		} });
		for (const url of ["/", "/api", "/demo", "/stats", "/agents", "/install", "/changelog", "/favicon.svg", "/api/stats", "/health"]) {
			await app.inject({ method: "GET", url, headers: { "user-agent": "not retained", "x-forwarded-for": "203.0.113.10" } });
		}
		expect(viewedPaths).toEqual(["/", "/api", "/demo", "/stats", "/agents", "/install", "/changelog"]);
		await app.close();
	});

	it("does not expose internal errors when aggregate storage is unavailable", async () => {
		const app = buildApp({ stats: { getPublicStats: () => Promise.reject(new Error("db-secret-should-not-leak")) } });
		const response = await app.inject({ method: "GET", url: "/api/stats" });
		expect(response.statusCode).toBe(503);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.json()).toEqual({ error: "stats unavailable" });
		expect(response.body).not.toContain("db-secret-should-not-leak");
		await app.close();
	});
});

function emptyPlan() { return { quotesIssued: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0 }; }
function emptyPlans(overrides: Partial<Record<"spark" | "standard" | "long", ReturnType<typeof emptyPlan>>> = {}) { return { spark: emptyPlan(), standard: emptyPlan(), long: emptyPlan(), ...overrides }; }
function emptyProduct() { return { ...emptyPlan(), byPlan: emptyPlans() }; }
function emptyStats() { const period = { pageViews: 0, quotesIssued: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0 }; return { pageViews: 0, viewsToday: 0, viewsLast7Days: 0, quotesIssued: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0, periods: { all: period, today: period, last7Days: period, last30Days: period }, funnel: { trackingStartedOn: null, pageViews: 0, quotesIssued: 0, paidPayments: 0, dispensedResources: 0, visitToQuotePercent: 0, quoteToPaidPercent: 0, paidToDispensedPercent: 0 }, activityLast30Days: [], byProduct: { catch: emptyProduct(), whisper: emptyProduct(), pulse: emptyProduct() } }; }
