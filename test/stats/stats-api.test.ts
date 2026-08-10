import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("public stats", () => {
	it("serves privacy-safe aggregates with a short public cache", async () => {
		const stats = {
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
