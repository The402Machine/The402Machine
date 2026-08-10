import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("public stats", () => {
	it("serves privacy-safe aggregates with a short public cache", async () => {
		const stats = {
			pageViews: 1_402,
			viewsToday: 42,
			viewsLast7Days: 402,
			paidPayments: 5,
			dispensedResources: 4,
			receivedSats: 570,
			byProduct: {
				catch: { paidPayments: 2, dispensedResources: 2, receivedSats: 84 },
				whisper: { paidPayments: 2, dispensedResources: 1, receivedSats: 444 },
				pulse: { paidPayments: 1, dispensedResources: 1, receivedSats: 42 },
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
			getPublicStats: () => Promise.resolve({ pageViews: 0, viewsToday: 0, viewsLast7Days: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0, byProduct: { catch: { paidPayments: 0, dispensedResources: 0, receivedSats: 0 }, whisper: { paidPayments: 0, dispensedResources: 0, receivedSats: 0 }, pulse: { paidPayments: 0, dispensedResources: 0, receivedSats: 0 } } }),
			recordPageView: (path) => { viewedPaths.push(path); return Promise.resolve(); },
		} });
		for (const url of ["/", "/api", "/demo", "/stats", "/favicon.svg", "/api/stats", "/health"]) {
			await app.inject({ method: "GET", url, headers: { "user-agent": "not retained", "x-forwarded-for": "203.0.113.10" } });
		}
		expect(viewedPaths).toEqual(["/", "/api", "/demo", "/stats"]);
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
