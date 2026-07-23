import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { PaymentQuote } from "../../src/payment/payment-service.js";

describe("public payment API", () => {
	it("returns a Lightning invoice with HTTP 402 and reuses the idempotency key", async () => {
		const quote: PaymentQuote = { orderId: "order-1", product: "catch", planId: "spark", amountSats: 42, bolt11: "lnbc42n1test", paymentHash: "a".repeat(64) };
		const calls: unknown[] = [];
		const app = buildApp({ payment: {
			quote: (input) => { calls.push(input); return Promise.resolve(quote); },
			fulfill: () => Promise.resolve({ settled: false }),
		} });
		const response = await app.inject({ method: "POST", url: "/api/payments/catch", headers: { "idempotency-key": "idempotency-public-1" }, payload: { planId: "spark" } });
		expect(response.statusCode).toBe(402);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.json()).toEqual(quote);
		expect(calls).toEqual([{ idempotencyKey: "idempotency-public-1", product: "catch", planId: "spark", productPayload: null }]);
		await app.close();
	});

	it("parses checkout JSON when CATCH ingestion is installed in the same app", async () => {
		const quote: PaymentQuote = { orderId: "order-combined", product: "catch", planId: "spark", amountSats: 42, bolt11: "lnbc42n1combined", paymentHash: "e".repeat(64) };
		const calls: unknown[] = [];
		const repository = {
			provision: () => Promise.reject(new Error("not used")), getCredentialHashes: () => Promise.resolve(null),
			acceptEvent: () => Promise.resolve({ accepted: false as const, reason: "not_found" as const }), getResource: () => Promise.resolve(null),
			listEvents: () => Promise.resolve([]), deleteEvent: () => Promise.resolve(false), destroy: () => Promise.resolve(false),
		};
		const app = buildApp({
			catch: { repository, tokenPepper: "pepper", provisioningEnabled: false },
			payment: { quote: (input) => { calls.push(input); return Promise.resolve(quote); }, fulfill: () => Promise.resolve({ settled: false }) },
		});
		const response = await app.inject({ method: "POST", url: "/api/payments/catch", headers: { "content-type": "application/json", "idempotency-key": "idempotency-combined-1" }, payload: { planId: "spark" } });
		expect(response.statusCode).toBe(402);
		expect(calls).toEqual([{ idempotencyKey: "idempotency-combined-1", product: "catch", planId: "spark", productPayload: null }]);
		await app.close();
	});

	it("quotes a client-encrypted WHISPER without accepting plaintext media types", async () => {
		const quote: PaymentQuote = { orderId: "order-whisper", product: "whisper", planId: "spark", amountSats: 42, bolt11: "lnbc42n1whisper", paymentHash: "d".repeat(64) };
		const calls: unknown[] = [];
		const app = buildApp({ payment: {
			quote: (input) => { calls.push(input); return Promise.resolve(quote); },
			fulfill: () => Promise.resolve({ settled: false }),
		} });
		const ciphertext = Buffer.from([1, ...Array.from({ length: 29 }, (_, index) => index)]);
		const response = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-1", "x-whisper-plan": "spark", "content-type": "application/octet-stream" }, payload: ciphertext });
		expect(response.statusCode).toBe(402);
		expect(response.json()).toEqual(quote);
		expect(calls).toEqual([{ idempotencyKey: "idempotency-whisper-1", product: "whisper", planId: "spark", productPayload: ciphertext }]);
		const plaintext = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-2", "x-whisper-plan": "spark", "content-type": "text/plain" }, payload: "secret" });
		expect(plaintext.statusCode).toBe(400);
		await app.close();
	});

	it("does not expose credentials before payment and returns them after fulfillment", async () => {
		const resource = { product: "catch" as const, resourceId: "resource-1", publicId: "catch_once", ownerToken: "owner-token", ingestToken: "ingest-token", expiresAt: new Date("2026-07-23T12:00:00.000Z") };
		let settled = false;
		const app = buildApp({ payment: {
			quote: () => Promise.reject(new Error("not used")),
			fulfill: () => Promise.resolve(settled ? { settled: true, resource } : { settled: false }),
		} });
		const pending = await app.inject({ method: "GET", url: "/api/payments/order-1" });
		expect(pending.statusCode).toBe(402);
		expect(pending.json()).toEqual({ settled: false });
		settled = true;
		const paid = await app.inject({ method: "GET", url: "/api/payments/order-1" });
		expect(paid.statusCode).toBe(200);
		expect(paid.json()).toMatchObject({ settled: true, resource: { publicId: "catch_once", ownerToken: "owner-token", ingestToken: "ingest-token" } });
		await app.close();
	});

	it("accepts Long for both products", async () => {
		const calls: unknown[] = [];
		const quote: PaymentQuote = { orderId: "order-long", product: "catch", planId: "long", amountSats: 4_002, bolt11: "lnbc4002n1long", paymentHash: "b".repeat(64) };
		const app = buildApp({ payment: { quote: (input) => { calls.push(input); return Promise.resolve(quote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const response = await app.inject({ method: "POST", url: "/api/payments/catch", headers: { "idempotency-key": "idempotency-public-2" }, payload: { planId: "long" } });
		expect(response.statusCode).toBe(402);
		expect(calls).toEqual([{ idempotencyKey: "idempotency-public-2", product: "catch", planId: "long", productPayload: null }]);
		await app.close();
	});

	it("publishes detailed product-specific comparison data", async () => {
		const app = buildApp({ payment: { quote: () => Promise.reject(new Error("not used")), fulfill: () => Promise.resolve({ settled: false }) } });
		const response = await app.inject({ method: "GET", url: "/api/catalog" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ checkoutEnabled: true, currency: "sat", products: {
			catch: { plans: [
				{ planId: "spark", priceSats: 42, durationLabel: "4h 02m", requestLimit: 402, storageLimitBytes: 2 * 1024 * 1024, maxBytesPerRequest: 64 * 1024, available: true },
				{ planId: "standard", priceSats: 402, durationLabel: "30 days", requestLimit: 4_020, storageLimitBytes: 20 * 1024 * 1024, maxBytesPerRequest: 256 * 1024, available: true },
				{ planId: "long", priceSats: 4_002, durationLabel: "4 months + 2 days", requestLimit: 40_200, storageLimitBytes: 200 * 1024 * 1024, maxBytesPerRequest: 1024 * 1024, available: true },
			] },
			whisper: { plans: [
				{ planId: "spark", priceSats: 42, durationLabel: "7 days", readOnce: true, available: true },
				{ planId: "standard", priceSats: 402, durationLabel: "42 days", readOnce: true, available: true },
				{ planId: "long", priceSats: 4_002, durationLabel: "402 days", readOnce: true, available: true },
			] },
		} });
		await app.close();
	});

	it("rate-limits invoice creation and verification before payment backend work", async () => {
		let quotes = 0;
		let fulfillments = 0;
		const app = buildApp({ payment: {
			quote: () => { quotes += 1; return Promise.resolve({ orderId: "order-rate", product: "catch", planId: "spark", amountSats: 42, bolt11: "lnbc42n1rate", paymentHash: "f".repeat(64) }); },
			fulfill: () => { fulfillments += 1; return Promise.resolve({ settled: false }); },
		} });
		let quoteStatus = 0;
		for (let attempt = 0; attempt < 11; attempt += 1) {
			quoteStatus = (await app.inject({ method: "POST", url: "/api/payments/catch", headers: { "content-type": "application/json", "idempotency-key": `rate-key-${attempt}` }, payload: { planId: "spark" } })).statusCode;
		}
		expect(quoteStatus).toBe(429);
		expect(quotes).toBe(10);
		let verifyStatus = 0;
		for (let attempt = 0; attempt < 31; attempt += 1) verifyStatus = (await app.inject({ method: "GET", url: `/api/payments/order-${attempt}` })).statusCode;
		expect(verifyStatus).toBe(429);
		expect(fulfillments).toBe(30);
		await app.close();
	});
});