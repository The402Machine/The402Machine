import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
	await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("public landing page", () => {
	it("serves the product landing page", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/html");
		expect(response.body).toContain("Tiny internet appliances");
		expect(response.body).toContain("4 weeks + 2 days");
		expect(response.body).toContain("4 months + 2 days");
		expect(response.body).toContain("CATCH");
		expect(response.body).toContain("BURN");
	});

	it("exposes the landing stylesheet", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/assets/styles.css" });

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/css");
		expect(response.body).toContain("--acid");
	});

	it("keeps operational implementation details out of public HTML", async () => {
		const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

		expect(html).not.toContain("PAYMENT_API_KEY");
		expect(html).not.toContain("DATABASE_URL");
		expect(html).not.toContain("REDIS_URL");
	});
});
