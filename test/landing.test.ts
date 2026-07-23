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
		expect(response.body).toContain("Rent less internet");
		expect(response.body).toContain("40d 02h");
		expect(response.body).toContain("4 months + 2 days");
		expect(response.body).toContain("CATCH");
		expect(response.body).toContain("WHISPER");
		expect(response.body).toContain('<div class="plan-price"><strong>42</strong><span>SATS</span>');
		expect(response.body).toContain('<div class="plan-price"><strong>402</strong><span>SATS</span>');
		expect(response.body).toContain('<div class="plan-price"><strong>4,002</strong><span>SATS</span>');
		expect(response.body).toContain("7 days");
		expect(response.body).toContain("42 days");
		expect(response.body).toContain("402 days");
		expect(response.body).toContain("4.02 MiB encrypted");
		expect(response.body).toContain("KEY / URL FRAGMENT");
		expect(response.body).toContain('class="catalogue-illustration"');
		expect(response.body).toContain('class="product-icon"');
		expect(response.body).toContain("<title>CATCH webhook inbox</title>");
		expect(response.body).toContain("<title>WHISPER read-once note</title>");
		expect(response.body).toContain("plan-price");
		expect(response.body).not.toContain("Start with the job, then pick the fuse");
		expect(response.body).not.toContain("A1 · MACHINE INPUT");
		expect(response.body).not.toContain("A private webhook inbox that accepts bounded POST requests");
		expect(response.body).not.toContain("Write a message in the browser. It is encrypted before upload");
		expect(response.body).not.toContain("Fast debugging and compact webhook events");
		expect(response.body).toContain("64 KiB");
		expect(response.body).toContain("256 KiB");
		expect(response.body).toContain("1 MiB");
		expect(response.body).toContain("available cartridges");
		expect(response.body).toContain("CHECKING LIGHTNING CHECKOUT");
		expect(response.body).toContain("TWO CARTRIDGES LIVE");
		expect(response.body).toContain("Source-available");
		expect(response.body).not.toContain("Open source");
		expect(response.body).toContain('data-buy="catch"');
		expect(response.body).toContain('data-buy="whisper"');
		expect(response.body).toContain('data-plan="long"');
		expect(response.body).toContain('href="/assets/styles.css?v=8"');
		expect(response.body).toContain('src="/assets/checkout.js?v=11"');
		expect(response.body).toContain('id="checkout-payment"');
		expect(response.body).toContain('id="checkout-qr"');
		expect(response.body).toContain('id="checkout-wallet"');
		expect(response.body).toContain('id="checkout-copy"');
		expect(response.body).toContain('id="checkout-progress"');
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
		expect(response.body).toContain('src="/assets/whisper-page.js?v=2"');
		expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
		expect(response.headers["content-security-policy"]).not.toContain("script-src 'none'");
	});

	it("keeps operational implementation details out of public HTML", async () => {
		const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

		expect(html).not.toContain("PAYMENT_API_KEY");
		expect(html).not.toContain("DATABASE_URL");
		expect(html).not.toContain("REDIS_URL");
	});

	it("keeps the payment catalogue unregistered when checkout is disabled", async () => {
		const app = buildApp();
		apps.push(app);

		const response = await app.inject({ method: "GET", url: "/api/catalog" });

		expect(response.statusCode).toBe(404);
	});

	it("disables checkout buttons when the payment catalogue is unavailable", async () => {
		const source = await readFile(new URL("../public/assets/checkout.js", import.meta.url), "utf8");

		expect(source).toContain('fetch("/api/catalog"');
		expect(source).toContain("disableCheckout()");
		expect(source).toContain('button.textContent = "Checkout disabled"');
		expect(source).toContain("renderPlanChoices");
		expect(source).not.toContain('data.get("planId") === "standard"');
	});

	it("keeps the WHISPER message field out of CATCH checkout", async () => {
		const [source, styles] = await Promise.all([
			readFile(new URL("../public/assets/checkout.js", import.meta.url), "utf8"),
			readFile(new URL("../public/assets/styles.css", import.meta.url), "utf8"),
		]);

		expect(source).toContain('noteField.hidden = product !== "whisper"');
		expect(styles).toContain("[hidden] { display: none !important; }");
	});

	it("presents the invoice as a QR, Lightning link, WebLN action, and pending state", async () => {
		const [source, qrBundle, webLnBundle] = await Promise.all([
			readFile(new URL("../public/assets/checkout.js", import.meta.url), "utf8"),
			readFile(new URL("../public/assets/qr-browser-v3.js", import.meta.url), "utf8"),
			readFile(new URL("../public/assets/webln-browser.js", import.meta.url), "utf8"),
		]);

		expect(source).toContain('import { renderQr } from "/assets/qr-browser-v3.js"');
		expect(source).toContain('import { requestProvider } from "/assets/webln-browser.js"');
		expect(source).toContain('href = `lightning:${quote.bolt11}`');
		expect(source).toContain("navigator.clipboard.writeText");
		expect(source).toContain("requestProvider");
		expect(source).toContain("sendPayment(currentInvoice)");
		expect(source).toContain('data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrMarkup)}');
		expect(source).toContain("qr.replaceChildren(qrImage)");
		expect(source).toContain('setPaymentStage("pending")');
		expect(source).toContain('setPaymentStage("paid")');
		expect(source).toContain("form.dataset.stage = stage");
		expect(source).toContain("session !== checkoutSession || !dialog.open");
		expect(source).toContain("output.hidden = false");
		expect(source).toContain("attempt < 205");
		expect(source).not.toContain("window.webln.enable()");
		expect(qrBundle.length).toBeGreaterThan(1_000);
		expect(qrBundle).toContain("Lightning invoice QR code");
		expect(webLnBundle.length).toBeGreaterThan(1_000);
		expect(webLnBundle).toContain("requestProvider");
	});
});
