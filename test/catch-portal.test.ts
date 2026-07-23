import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
	await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("CATCH owner portal", () => {
	it("serves a saveable owner portal without embedding credentials in the document", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/catch.html" });

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("Your CATCH<br /><em>portal.</em>");
		expect(response.body).toContain('href="/assets/styles.css?v=10"');
		expect(response.body).toContain('src="/assets/catch-portal.js?v=2"');
		expect(response.body).toContain('id="portal-import"');
		expect(response.body).toContain('id="portal-import-submit"');
		expect(response.body).toContain('id="portal-link-card" class="portal-link-card" hidden');
		expect(response.body).toContain('id="portal-ingest-auth"');
		expect(response.body).toContain('id="portal-event-access"');
		expect(response.body).toContain('id="portal-event-method"');
		expect(response.body).toContain('id="portal-event-content-type"');
		expect(response.body).toContain('id="portal-event-search"');
		expect(response.body).toContain('id="portal-event-page-size"');
		expect(response.body).toContain('id="portal-events-prev"');
		expect(response.body).toContain('id="portal-events-next"');
		expect(response.body).not.toContain("catch_own_");
		expect(response.body).not.toContain("catch_ing_");
	});

	it("keeps capability credentials in the URL fragment and authenticates owner API calls", async () => {
		const source = await readFile(new URL("../public/assets/catch-portal.js", import.meta.url), "utf8");

		expect(source).toContain("location.hash.slice(1)");
		expect(source).toContain("JSON.parse(importValue.value)");
		expect(source).toContain("history.replaceState");
		expect(source).toContain("encodeCapability(imported)");
		expect(source).toContain("linkCard.hidden = false");
		expect(source).toContain('authorization: `Bearer ${capability.ownerToken}`');
		expect(source).toContain("/api/catch/${encodeURIComponent(capability.publicId)}");
		expect(source).toContain("URLSearchParams");
		expect(source).toContain('parameters.set("cursor"');
		expect(source).toContain('parameters.set("access"');
		expect(source).toContain('parameters.set("method"');
		expect(source).toContain('`${apiUrl()}/settings`');
		expect(source).toContain('method: "DELETE"');
		expect(source).not.toContain("localStorage");
		expect(source).not.toContain("sessionStorage");
		expect(source).not.toContain("document.cookie");
		expect(source).not.toContain("innerHTML");
		expect(source).not.toContain("slice(-6)");
	});

	it("adds a direct portal action and saveable portal URL after CATCH is dispensed", async () => {
		const [checkout, html] = await Promise.all([
			readFile(new URL("../public/assets/checkout.js", import.meta.url), "utf8"),
			readFile(new URL("../public/index.html", import.meta.url), "utf8"),
		]);

		expect(html).toContain('id="checkout-portal"');
		expect(html).toContain('id="checkout-copy-portal"');
		expect(checkout).toContain("portalUrl:");
		expect(checkout).toContain("/catch.html#");
		expect(checkout).toContain("portalLink.href = portalUrl");
		expect(checkout).toContain("deliveryActions.hidden = false");
	});
});