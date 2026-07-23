import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { PaymentQuote } from "../../src/payment/payment-service.js";

describe("public payment API", () => {
	it("returns a Lightning invoice with HTTP 402 and reuses the idempotency key", async () => {
		const quote: PaymentQuote = { orderId: "order-1", product: "catch", planId: "spark", amountSats: 4, bolt11: "lnbc4n1test", paymentHash: "a".repeat(64) };
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

	it("quotes a client-encrypted WHISPER without accepting plaintext media types", async () => {
		const quote: PaymentQuote = { orderId: "order-whisper", product: "whisper", planId: "spark", amountSats: 4, bolt11: "lnbc4n1whisper", paymentHash: "d".repeat(64) };
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

	it("rejects Long while it remains unavailable", async () => {
		const app = buildApp({ payment: { quote: () => Promise.reject(new Error("not used")), fulfill: () => Promise.resolve({ settled: false }) } });
		const response = await app.inject({ method: "POST", url: "/api/payments/catch", headers: { "idempotency-key": "idempotency-public-2" }, payload: { planId: "long" } });
		expect(response.statusCode).toBe(400);
		await app.close();
	});

	it("publishes a machine-readable tiny-sats catalogue", async () => {
		const app = buildApp({ payment: { quote: () => Promise.reject(new Error("not used")), fulfill: () => Promise.resolve({ settled: false }) } });
		const response = await app.inject({ method: "GET", url: "/api/catalog" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ currency: "sat", products: { catch: [
			{ planId: "spark", priceSats: 4, available: true },
			{ planId: "standard", priceSats: 42, available: true },
			{ planId: "long", priceSats: 402, available: false },
		] } });
		await app.close();
	});

	it("rate-limits invoice creation and verification before payment backend work", async () => {
		let quotes = 0;
		let fulfillments = 0;
		const app = buildApp({ payment: {
			quote: () => { quotes += 1; return Promise.resolve({ orderId: "order-rate", product: "catch", planId: "spark", amountSats: 4, bolt11: "lnbc4n1rate", paymentHash: "f".repeat(64) }); },
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