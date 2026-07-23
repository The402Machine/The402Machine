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
		expect(response.body).toContain("WHISPER");
		expect(response.body).toContain("SPARK · 4 SATS");
		expect(response.body).toContain("STANDARD · 42 SATS");
		expect(response.body).toContain("LONG · 402 SATS");
		expect(response.body).toContain("CATCH CORE ONLINE");
		expect(response.body).toContain("TWO CARTRIDGES READY");
		expect(response.body).toContain('data-buy="catch"');
		expect(response.body).toContain('data-buy="whisper"');
		expect(response.body).toContain('src="/assets/checkout.js"');
	});

	it("exposes the landing stylesheet", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/assets/styles.css" });

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/css");
		expect(response.body).toContain("--acid");
	});

	it("serves WHISPER with external client code allowed by the CSP", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/whisper.html" });

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain('src="/assets/whisper-page.js"');
		expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
		expect(response.headers["content-security-policy"]).not.toContain("script-src 'none'");
	});

	it("keeps operational implementation details out of public HTML", async () => {
		const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

		expect(html).not.toContain("PAYMENT_API_KEY");
		expect(html).not.toContain("DATABASE_URL");
		expect(html).not.toContain("REDIS_URL");
	});
});
