import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
	await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("GET /health", () => {
	it("reports the service as healthy", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/health" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			service: "the402machine",
			status: "ok",
		});
	});
});
