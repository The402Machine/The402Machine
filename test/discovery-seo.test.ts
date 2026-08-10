import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const readPublic = async (path: string): Promise<string> => readFile(new URL(`../public/${path}`, import.meta.url), "utf8");

describe("agent discovery and public SEO", () => {
	it("publishes a strict machine-readable discovery manifest", async () => {
		const source = await readPublic(".well-known/the402machine.json");
		const manifest = JSON.parse(source) as Record<string, unknown>;
		expect(manifest).toMatchObject({
			name: "The402Machine",
			home: "https://the402machine.com/",
			catalog: "https://the402machine.com/api/catalog",
			openapi: "https://the402machine.com/openapi.json",
			agentGuide: "https://the402machine.com/agents",
			paymentProtocols: ["native-lightning", "payment-auth", "l402"],
			products: ["catch", "whisper", "pulse"],
		});
		expect(Object.keys(manifest).sort()).toEqual(["agentGuide", "catalog", "home", "name", "openapi", "paymentProtocols", "products", "version"].sort());
		expect(source).not.toMatch(/(?:preimage|macaroon|ownerToken|readToken|ingestToken|pingToken|lnbc[0-9A-Za-z]{20,})/u);
	});

	it("serves discovery, robots, sitemap, installation, changelog, and agent guide surfaces", async () => {
		const app = buildApp();
		for (const [url, contentType, expected] of [
			["/.well-known/the402machine.json", "application/json", '"paymentProtocols"'],
			["/robots.txt", "text/plain", "Sitemap: https://the402machine.com/sitemap.xml"],
			["/sitemap.xml", "application/xml", "https://the402machine.com/agents"],
			["/agents", "text/html", "AGENT PURCHASE GUIDE"],
			["/install", "text/html", "INSTALL / SELF-HOST"],
			["/changelog", "text/html", "PUBLIC CHANGELOG"],
		] as const) {
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode, url).toBe(200);
			expect(response.headers["content-type"], url).toContain(contentType);
			expect(response.body, url).toContain(expected);
		}
		await app.close();
	});

	it("documents one complete safe purchase flow for native, Payment Auth, and L402 agents", async () => {
		const html = await readPublic("agents.html");
		for (const expected of [
			"curl --fail-with-body",
			"Idempotency-Key",
			"Expected HTTP 402",
			"X-Payment-Protocol: payment",
			"WWW-Authenticate: Payment",
			"Authorization: Payment",
			"Payment-Receipt",
			"X-Payment-Protocol: l402",
			"WWW-Authenticate: L402",
			"Authorization: L402",
			"umask 077",
			"set +x",
			"chmod 600",
			"resource.product",
			"catch",
			"whisper",
			"pulse",
			"preserve the exact request body bytes",
		]) expect(html).toContain(expected);
		expect(html.indexOf("umask 077")).toBeLessThan(html.indexOf("quote.headers"));
		expect(html.indexOf("umask 077", html.indexOf('id="payment-auth"'))).toBeLessThan(html.indexOf("payment.headers"));
		expect(html.indexOf("umask 077", html.indexOf('id="l402"'))).toBeLessThan(html.indexOf("l402.headers"));
		expect(html).toContain("--config payment-auth.conf");
		expect(html).toContain("--config l402-auth.conf");
		expect(html).not.toContain('--header "Authorization: $AUTHORIZATION"');
		expect(html).not.toMatch(/lnbc[0-9A-Za-z]{20,}/u);
		expect(html).not.toMatch(/(?:owner|read|ingest|ping)[_-]?[Tt]oken["']?\s*[:=]\s*["'][A-Za-z0-9_-]{12,}/u);
	});

	it("keeps the reference agent client from printing invoices, preimages, or delivered capabilities", async () => {
		const source = await readFile(new URL("../examples/agent-payment-client.mjs", import.meta.url), "utf8");
		expect(source).toContain("umask");
		expect(source).toContain("chmod");
		expect(source).toContain("invoice.json");
		expect(source).toContain("capability.json");
		expect(source).toContain("resource.product");
		expect(source).not.toContain("console.log(JSON.stringify({ protocol, invoice");
		expect(source).not.toContain("console.log(JSON.stringify({ status:");
		expect(source).not.toContain("responseBody }, null, 2)");
	});

	it("adds canonical, Open Graph, X card, and SoftwareApplication metadata to indexable pages", async () => {
		const pages = [
			["index.html", "https://the402machine.com/"],
			["api.html", "https://the402machine.com/api"],
			["stats.html", "https://the402machine.com/stats"],
			["agents.html", "https://the402machine.com/agents"],
			["install.html", "https://the402machine.com/install"],
			["changelog.html", "https://the402machine.com/changelog"],
		] as const;
		for (const [page, canonical] of pages) {
			const html = await readPublic(page);
			expect(html, page).toContain(`<link rel="canonical" href="${canonical}" />`);
			expect(html, page).toContain('<meta property="og:type" content="website" />');
			expect(html, page).toContain('<meta property="og:image" content="https://the402machine.com/og-image.png" />');
			expect(html, page).toContain('<meta name="twitter:card" content="summary_large_image" />');
			expect(html, page).toContain('<meta name="twitter:image" content="https://the402machine.com/og-image.png" />');
		}
		const home = await readPublic("index.html");
		expect(home).toContain('<script type="application/ld+json">');
		expect(home).toContain('"@type": "SoftwareApplication"');
		expect(home).toContain('"applicationCategory": "DeveloperApplication"');
	});

	it("keeps private capability pages out of robots and the sitemap", async () => {
		const [robots, sitemap] = await Promise.all([readPublic("robots.txt"), readPublic("sitemap.xml")]);
		for (const path of ["/catch", "/whisper", "/pulse", "/pulse-public", "/api/catch", "/api/pulse", "/w/", "/p/", "/c/"]) expect(robots).toContain(`Disallow: ${path}`);
		for (const path of ["/catch", "/whisper", "/pulse", "/pulse-public", "/demo"]) expect(sitemap).not.toContain(`<loc>https://the402machine.com${path}</loc>`);
	});

	it("ships a real social preview image", async () => {
		const image = await readFile(new URL("../public/og-image.png", import.meta.url));
		expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(image.byteLength).toBeGreaterThan(20_000);
	});
});
