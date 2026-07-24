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
			listEvents: () => Promise.resolve({ events: [], nextCursor: null }), setEventIpLocation: () => Promise.resolve(false), deleteEvent: () => Promise.resolve(false), destroy: () => Promise.resolve(false),
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
		expect(calls).toEqual([{ idempotencyKey: "idempotency-whisper-1", product: "whisper", planId: "spark", productPayload: ciphertext, whisperReadLimit: 1, whisperRevealAt: null }]);
		const plaintext = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-2", "x-whisper-plan": "spark", "content-type": "text/plain" }, payload: "secret" });
		expect(plaintext.statusCode).toBe(400);
		await app.close();
	});

	it("accepts a scheduled WHISPER reveal for every plan and persists it in quote identity", async () => {
		const ciphertext = Buffer.from([1, ...Array.from({ length: 29 }, (_, index) => index)]);
		const calls: unknown[] = [];
		const quote: PaymentQuote = { orderId: "order-whisper-scheduled", product: "whisper", planId: "spark", amountSats: 42, bolt11: "lnbc42n1scheduled", paymentHash: "7".repeat(64) };
		const app = buildApp({ payment: { quote: (input) => { calls.push(input); return Promise.resolve(quote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		for (const [planId, revealAt] of [
			["spark", "2026-07-26T12:00:00.000Z"],
			["standard", "2026-08-01T12:00:00.000Z"],
			["long", "2027-01-01T12:00:00.000Z"],
		] as const) {
			const response = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": `idempotency-scheduled-${planId}`, "x-whisper-plan": planId, "x-whisper-reveal-at": revealAt, "content-type": "application/octet-stream" }, payload: ciphertext });
			expect(response.statusCode).toBe(402);
		}
		expect(calls).toEqual([
			{ idempotencyKey: "idempotency-scheduled-spark", product: "whisper", planId: "spark", productPayload: ciphertext, whisperReadLimit: 1, whisperRevealAt: new Date("2026-07-26T12:00:00.000Z") },
			{ idempotencyKey: "idempotency-scheduled-standard", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42, whisperRevealAt: new Date("2026-08-01T12:00:00.000Z") },
			{ idempotencyKey: "idempotency-scheduled-long", product: "whisper", planId: "long", productPayload: ciphertext, whisperReadLimit: 402, whisperRevealAt: new Date("2027-01-01T12:00:00.000Z") },
		]);
		await app.close();
	});

	it("rejects malformed or over-horizon scheduled reveals before payment backend work", async () => {
		const calls: unknown[] = [];
		const app = buildApp({ payment: { quote: (input) => { calls.push(input); return Promise.reject(new Error("not expected")); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const ciphertext = Buffer.from([1, ...Array.from({ length: 29 }, (_, index) => index)]);
		for (const revealAt of ["not-a-date", "9999-01-01T00:00:00.000Z"]) {
			const response = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": `invalid-reveal-${revealAt}`, "x-whisper-plan": "spark", "x-whisper-reveal-at": revealAt, "content-type": "application/octet-stream" }, payload: ciphertext });
			expect(response.statusCode).toBe(400);
		}
		expect(calls).toHaveLength(0);
		await app.close();
	});

	it("accepts a WHISPER note near 4.02 MiB and rejects a larger ciphertext", async () => {
		const burnCalls: unknown[] = [];
		const burnQuote: PaymentQuote = { orderId: "order-whisper-burn", product: "whisper", planId: "standard", amountSats: 402, bolt11: "lnbc402n1burn", paymentHash: "8".repeat(64) };
		const burnApp = buildApp({ payment: { quote: (input) => { burnCalls.push(input); return Promise.resolve(burnQuote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const burnCiphertext = Buffer.from([1, ...Array.from({ length: 29 }, (_, index) => index)]);
		const burn = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-burn", "x-whisper-plan": "standard", "x-whisper-read-limit": "1", "content-type": "application/octet-stream" }, payload: burnCiphertext });
		expect(burn.statusCode).toBe(402);
		expect(burnCalls).toEqual([{ idempotencyKey: "idempotency-whisper-burn", product: "whisper", planId: "standard", productPayload: burnCiphertext, whisperReadLimit: 1, whisperRevealAt: null }]);
		const allowance = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-allowance", "x-whisper-plan": "standard", "content-type": "application/octet-stream" }, payload: burnCiphertext });
		expect(allowance.statusCode).toBe(402);
		expect(burnCalls.at(-1)).toEqual({ idempotencyKey: "idempotency-whisper-allowance", product: "whisper", planId: "standard", productPayload: burnCiphertext, whisperReadLimit: 42, whisperRevealAt: null });
		const invalid = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-invalid", "x-whisper-plan": "standard", "x-whisper-read-limit": "2", "content-type": "application/octet-stream" }, payload: burnCiphertext });
		expect(invalid.statusCode).toBe(400);
		expect(burnCalls).toHaveLength(2);
		await burnApp.close();

		const calls: unknown[] = [];
		const quote: PaymentQuote = { orderId: "order-whisper-large", product: "whisper", planId: "spark", amountSats: 42, bolt11: "lnbc42n1large", paymentHash: "c".repeat(64) };
		const app = buildApp({ payment: { quote: (input) => { calls.push(input); return Promise.resolve(quote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const accepted = Buffer.alloc(4_215_276, 7);
		accepted[0] = 1;
		const response = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-large", "x-whisper-plan": "spark", "content-type": "application/octet-stream" }, payload: accepted });
		expect(response.statusCode).toBe(402);
		expect(calls).toHaveLength(1);
		const oversized = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-too-large", "x-whisper-plan": "spark", "content-type": "application/octet-stream" }, payload: Buffer.alloc(4_215_277, 7) });
		expect(oversized.statusCode).toBeGreaterThanOrEqual(400);
		await app.close();
	});

	it("quotes PULSE as a fixed lifetime quota with no purchase payload", async () => {
		const quote: PaymentQuote = { orderId: "order-pulse", product: "pulse", planId: "standard", amountSats: 402, bolt11: "lnbc402n1pulse", paymentHash: "9".repeat(64) };
		const calls: unknown[] = [];
		const app = buildApp({ payment: { quote: (input) => { calls.push(input); return Promise.resolve(quote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const response = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "idempotency-key": "idempotency-pulse-1", "content-type": "application/json" }, payload: { planId: "standard" } });
		expect(response.statusCode).toBe(402);
		expect(response.json()).toEqual(quote);
		expect(calls).toEqual([{ idempotencyKey: "idempotency-pulse-1", product: "pulse", planId: "standard", productPayload: null }]);
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
				{ planId: "standard", priceSats: 402, durationLabel: "40d 02h", requestLimit: 4_020, storageLimitBytes: 20 * 1024 * 1024, maxBytesPerRequest: 256 * 1024, available: true },
				{ planId: "long", priceSats: 4_002, durationLabel: "4 months + 2 days", requestLimit: 40_200, storageLimitBytes: 200 * 1024 * 1024, maxBytesPerRequest: 1024 * 1024, available: true },
			] },
			whisper: { plans: [
				{ planId: "spark", priceSats: 42, durationLabel: "7 days", readLimit: 1, maxCiphertextBytes: 4_215_276, available: true },
				{ planId: "standard", priceSats: 402, durationLabel: "42 days", readLimit: 42, maxCiphertextBytes: 4_215_276, available: true },
				{ planId: "long", priceSats: 4_002, durationLabel: "402 days", readLimit: 402, maxCiphertextBytes: 4_215_276, available: true },
			] },
			pulse: { plans: [
				{ planId: "spark", priceSats: 42, durationLabel: "4d 02h", heartbeatLimit: 1_202, suggestedCadenceSeconds: 300, available: true },
				{ planId: "standard", priceSats: 402, durationLabel: "42 days", heartbeatLimit: 61_402, suggestedCadenceSeconds: 60, available: true },
				{ planId: "long", priceSats: 4_002, durationLabel: "402 days", heartbeatLimit: 1_740_402, suggestedCadenceSeconds: 20, available: true },
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