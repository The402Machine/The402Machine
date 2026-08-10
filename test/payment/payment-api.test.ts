import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createPaymentChallenge } from "../../src/payment/payment-protocol.js";
import type { PaymentQuote } from "../../src/payment/payment-service.js";

describe("public payment API", () => {
	it("returns a Lightning invoice with HTTP 402 and reuses the idempotency key", async () => {
		const quote: PaymentQuote = { orderId: "order-1", product: "catch", planId: "spark", amountSats: 42, bolt11: "lnbc42n1test", paymentHash: "a".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
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

	it("offers HTTP Payment Lightning charge and fulfills it with the preimage", async () => {
		const preimage = Buffer.alloc(32, 7).toString("hex");
		const quote: PaymentQuote = {
			orderId: "11111111-1111-4111-8111-111111111111", product: "pulse", planId: "spark", amountSats: 42,
			bolt11: "lnbc42n1agent", paymentHash: createHash("sha256").update(Buffer.alloc(32, 7)).digest("hex"),
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
		};
		const resource = { product: "pulse" as const, resourceId: "resource-agent", publicId: "pulse_agent", ownerToken: "owner-agent", pingToken: "ping-agent", expiresAt: new Date("2026-07-29T12:00:00.000Z") };
		const calls: unknown[] = [];
		const app = buildApp({
			paymentProtocols: { realm: "the402machine.com", secret: Buffer.alloc(32, 3) },
			payment: {
				quote: (input) => { calls.push(input); return Promise.resolve(quote); },
				fulfill: () => Promise.resolve({ settled: false }),
				fulfillAgentPayment: (input) => { calls.push(input); return Promise.resolve(input.orderId === quote.orderId && input.preimage === preimage ? { settled: true, resource } : { settled: false, reason: "invalid-preimage" }); },
			},
		});
		const body = Buffer.from('{"planId":"spark"}');
		const challengeResponse = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-pulse", "x-payment-protocol": "payment" }, payload: body });
		expect(challengeResponse.statusCode).toBe(402);
		expect(challengeResponse.headers["www-authenticate"]).toMatch(/^Payment /u);
		const challengeBody: { expiresAt: string } = challengeResponse.json();
		const expected = createPaymentChallenge({ quote, realm: "the402machine.com", method: "POST", path: "/api/payments/pulse", body, expiresAt: new Date(challengeBody.expiresAt), secret: Buffer.alloc(32, 3) });
		const authorization = `Payment ${Buffer.from(JSON.stringify({ challenge: expected.parameters, payload: { preimage } })).toString("base64url")}`;
		const fulfilled = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-pulse", authorization, "x-payment-protocol": "payment" }, payload: body });
		expect(fulfilled.statusCode).toBe(200);
		expect(fulfilled.headers["payment-receipt"]).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(fulfilled.json()).toMatchObject({ settled: true, resource: { product: "pulse", publicId: "pulse_agent" } });
		expect(calls).toHaveLength(3);
		expect(calls[2]).toMatchObject({ protocol: "payment", orderId: quote.orderId, paymentHash: quote.paymentHash, preimage });
		await app.close();
	});

	it("offers L402 compatibility and rejects a broken credential with HTTP 401", async () => {
		const preimage = Buffer.alloc(32, 11).toString("hex");
		const quote: PaymentQuote = { orderId: "22222222-2222-4222-8222-222222222222", product: "pulse", planId: "spark", amountSats: 42, bolt11: "lnbc42n1l402agent", paymentHash: createHash("sha256").update(Buffer.alloc(32, 11)).digest("hex"), expiresAt: new Date(Date.now() + 300_000).toISOString() };
		const resource = { product: "pulse" as const, resourceId: "resource-l402", publicId: "pulse_l402", ownerToken: "owner-l402", pingToken: "ping-l402", expiresAt: new Date("2026-07-29T12:00:00.000Z") };
		const app = buildApp({ paymentProtocols: { realm: "the402machine.com", secret: Buffer.alloc(32, 3) }, payment: {
			quote: () => Promise.resolve(quote), fulfill: () => Promise.resolve({ settled: false }),
			fulfillAgentPayment: ({ preimage: received }) => Promise.resolve(received === preimage ? { settled: true, resource } : { settled: false, reason: "invalid-preimage" }),
		} });
		const body = Buffer.from('{"planId":"spark"}');
		const challenge = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-l402", "x-payment-protocol": "l402" }, payload: body });
		expect(challenge.statusCode).toBe(402);
		const header = challenge.headers["www-authenticate"];
		if (typeof header !== "string") throw new Error("Missing L402 challenge");
		expect(header).toMatch(/^L402 macaroon="[A-Za-z0-9_-]+", invoice="lnbc42n1l402agent"$/u);
		const macaroon = /^L402 macaroon="([A-Za-z0-9_-]+)"/u.exec(header)?.[1];
		if (macaroon === undefined) throw new Error("Missing L402 macaroon");
		const fulfilled = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-l402", "x-payment-protocol": "l402", authorization: `L402 ${macaroon}:${preimage}` }, payload: body });
		expect(fulfilled.statusCode).toBe(200);
		expect(fulfilled.json()).toMatchObject({ settled: true, resource: { publicId: "pulse_l402" } });
		const rejected = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-l402", "x-payment-protocol": "l402", authorization: `L402 ${macaroon}:${Buffer.alloc(32, 12).toString("hex")}` }, payload: body });
		expect(rejected.statusCode).toBe(401);
		await app.close();
	});

	it("binds agent credentials to the exact JSON bytes sent on the wire", async () => {
		const preimage = Buffer.alloc(32, 13).toString("hex");
		const quote: PaymentQuote = { orderId: "23232323-2323-4232-8232-232323232323", product: "pulse", planId: "spark", amountSats: 42, bolt11: "lnbc42n1exactbody", paymentHash: createHash("sha256").update(Buffer.alloc(32, 13)).digest("hex"), expiresAt: new Date(Date.now() + 300_000).toISOString() };
		const app = buildApp({ paymentProtocols: { realm: "the402machine.com", secret: Buffer.alloc(32, 3) }, payment: {
			quote: () => Promise.resolve(quote), fulfill: () => Promise.resolve({ settled: false }),
			fulfillAgentPayment: () => Promise.reject(new Error("body binding must reject before settlement")),
		} });
		const challengeBody = Buffer.from('{ "planId": "spark" }');
		const retryBody = Buffer.from('{"planId":"spark"}');

		const paymentChallengeResponse = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "exact-json-payment", "x-payment-protocol": "payment" }, payload: challengeBody });
		const paymentChallenge = createPaymentChallenge({ quote, realm: "the402machine.com", method: "POST", path: "/api/payments/pulse", body: challengeBody, expiresAt: new Date(paymentChallengeResponse.json<{ expiresAt: string }>().expiresAt), secret: Buffer.alloc(32, 3) });
		const paymentAuthorization = `Payment ${Buffer.from(JSON.stringify({ challenge: paymentChallenge.parameters, payload: { preimage } })).toString("base64url")}`;
		const paymentRetry = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "exact-json-payment", "x-payment-protocol": "payment", authorization: paymentAuthorization }, payload: retryBody });
		expect(paymentRetry.statusCode).toBe(402);

		const l402Challenge = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "exact-json-l402", "x-payment-protocol": "l402" }, payload: challengeBody });
		const l402Header = l402Challenge.headers["www-authenticate"];
		if (typeof l402Header !== "string") throw new Error("Missing L402 challenge");
		const macaroon = /^L402 macaroon="([A-Za-z0-9_-]+)"/u.exec(l402Header)?.[1];
		if (macaroon === undefined) throw new Error("Missing L402 macaroon");
		const l402Retry = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "exact-json-l402", "x-payment-protocol": "l402", authorization: `L402 ${macaroon}:${preimage}` }, payload: retryBody });
		expect(l402Retry.statusCode).toBe(401);
		await app.close();
	});

	it("binds Payment credentials to the purchase route", async () => {
		const preimage = Buffer.alloc(32, 14).toString("hex");
		const paymentHash = createHash("sha256").update(Buffer.alloc(32, 14)).digest("hex");
		const pulseQuote: PaymentQuote = { orderId: "24242424-2424-4242-8242-242424242424", product: "pulse", planId: "spark", amountSats: 42, bolt11: "lnbc42n1route", paymentHash, expiresAt: new Date(Date.now() + 300_000).toISOString() };
		const catchQuote: PaymentQuote = { ...pulseQuote, product: "catch" };
		const app = buildApp({ paymentProtocols: { realm: "the402machine.com", secret: Buffer.alloc(32, 3) }, payment: {
			quote: ({ product }) => Promise.resolve(product === "pulse" ? pulseQuote : catchQuote), fulfill: () => Promise.resolve({ settled: false }),
			fulfillAgentPayment: () => Promise.reject(new Error("route binding must reject before settlement")),
		} });
		const body = Buffer.from('{"planId":"spark"}');
		const challengeResponse = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "route-bound-payment", "x-payment-protocol": "payment" }, payload: body });
		const challenge = createPaymentChallenge({ quote: pulseQuote, realm: "the402machine.com", method: "POST", path: "/api/payments/pulse", body, expiresAt: new Date(challengeResponse.json<{ expiresAt: string }>().expiresAt), secret: Buffer.alloc(32, 3) });
		const authorization = `Payment ${Buffer.from(JSON.stringify({ challenge: challenge.parameters, payload: { preimage } })).toString("base64url")}`;
		const wrongRoute = await app.inject({ method: "POST", url: "/api/payments/catch", headers: { "content-type": "application/json", "idempotency-key": "route-bound-payment", "x-payment-protocol": "payment", authorization }, payload: body });
		expect(wrongRoute.statusCode).toBe(402);
		await app.close();
	});

	it("consumes an HTTP Payment credential only once", async () => {
		const preimage = Buffer.alloc(32, 17).toString("hex");
		const quote: PaymentQuote = { orderId: "33333333-3333-4333-8333-333333333333", product: "pulse", planId: "spark", amountSats: 42, bolt11: "lnbc42n1replay", paymentHash: createHash("sha256").update(Buffer.alloc(32, 17)).digest("hex"), expiresAt: new Date(Date.now() + 300_000).toISOString() };
		const resource = { product: "pulse" as const, resourceId: "resource-replay", publicId: "pulse_replay", ownerToken: "owner-replay", pingToken: "ping-replay", expiresAt: new Date("2026-07-29T12:00:00.000Z") };
		let consumed = false;
		const app = buildApp({ paymentProtocols: { realm: "the402machine.com", secret: Buffer.alloc(32, 3) }, payment: {
			quote: () => Promise.resolve(quote), fulfill: () => Promise.resolve({ settled: false }),
			fulfillAgentPayment: () => { if (consumed) return Promise.resolve({ settled: false, reason: "replayed" }); consumed = true; return Promise.resolve({ settled: true, resource }); },
		} });
		const body = Buffer.from('{"planId":"spark"}');
		const initial = await app.inject({ method: "POST", url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-replay", "x-payment-protocol": "payment" }, payload: body });
		const challenge = createPaymentChallenge({ quote, realm: "the402machine.com", method: "POST", path: "/api/payments/pulse", body, expiresAt: new Date(initial.json<{ expiresAt: string }>().expiresAt), secret: Buffer.alloc(32, 3) });
		const authorization = `Payment ${Buffer.from(JSON.stringify({ challenge: challenge.parameters, payload: { preimage } })).toString("base64url")}`;
		const request = { method: "POST" as const, url: "/api/payments/pulse", headers: { "content-type": "application/json", "idempotency-key": "idempotency-agent-replay", "x-payment-protocol": "payment", authorization }, payload: body };
		expect((await app.inject(request)).statusCode).toBe(200);
		expect((await app.inject(request)).statusCode).toBe(402);
		await app.close();
	});

	it("parses checkout JSON when CATCH ingestion is installed in the same app", async () => {
		const quote: PaymentQuote = { orderId: "order-combined", product: "catch", planId: "spark", amountSats: 42, bolt11: "lnbc42n1combined", paymentHash: "e".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
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
		const quote: PaymentQuote = { orderId: "order-whisper", product: "whisper", planId: "spark", amountSats: 42, bolt11: "lnbc42n1whisper", paymentHash: "d".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
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
		const quote: PaymentQuote = { orderId: "order-whisper-scheduled", product: "whisper", planId: "spark", amountSats: 42, bolt11: "lnbc42n1scheduled", paymentHash: "7".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
		const app = buildApp({ payment: { quote: (input) => { calls.push(input); return Promise.resolve(quote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const now = Date.now();
		const scheduledReveals = [
			["spark", new Date(now + 24 * 60 * 60 * 1_000).toISOString()],
			["standard", new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString()],
			["long", new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString()],
		] as const;
		for (const [planId, revealAt] of scheduledReveals) {
			const response = await app.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": `idempotency-scheduled-${planId}`, "x-whisper-plan": planId, "x-whisper-reveal-at": revealAt, "content-type": "application/octet-stream" }, payload: ciphertext });
			expect(response.statusCode).toBe(402);
		}
		expect(calls).toEqual([
			{ idempotencyKey: "idempotency-scheduled-spark", product: "whisper", planId: "spark", productPayload: ciphertext, whisperReadLimit: 1, whisperRevealAt: new Date(scheduledReveals[0][1]) },
			{ idempotencyKey: "idempotency-scheduled-standard", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42, whisperRevealAt: new Date(scheduledReveals[1][1]) },
			{ idempotencyKey: "idempotency-scheduled-long", product: "whisper", planId: "long", productPayload: ciphertext, whisperReadLimit: 402, whisperRevealAt: new Date(scheduledReveals[2][1]) },
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
		const burnQuote: PaymentQuote = { orderId: "order-whisper-burn", product: "whisper", planId: "standard", amountSats: 402, bolt11: "lnbc402n1burn", paymentHash: "8".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
		const burnApp = buildApp({ payment: { quote: (input) => { burnCalls.push(input); return Promise.resolve(burnQuote); }, fulfill: () => Promise.resolve({ settled: false }) } });
		const burnCiphertext = Buffer.from([1, ...Array.from({ length: 29 }, (_, index) => index)]);
		const burn = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-burn", "x-whisper-plan": "standard", "x-whisper-read-limit": "1", "content-type": "application/octet-stream" }, payload: burnCiphertext });
		expect(burn.statusCode).toBe(402);
		expect(burnCalls).toEqual([{ idempotencyKey: "idempotency-whisper-burn", product: "whisper", planId: "standard", productPayload: burnCiphertext, whisperReadLimit: 1, whisperRevealAt: null }]);
		const allowance = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-allowance", "x-whisper-plan": "standard", "content-type": "application/octet-stream" }, payload: burnCiphertext });
		expect(allowance.statusCode).toBe(402);
		expect(burnCalls.at(-1)).toEqual({ idempotencyKey: "idempotency-whisper-allowance", product: "whisper", planId: "standard", productPayload: burnCiphertext, whisperReadLimit: 42, whisperRevealAt: null });
		const custom = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": "idempotency-whisper-custom", "x-whisper-plan": "standard", "x-whisper-read-limit": "12", "content-type": "application/octet-stream" }, payload: burnCiphertext });
		expect(custom.statusCode).toBe(402);
		expect(burnCalls.at(-1)).toEqual({ idempotencyKey: "idempotency-whisper-custom", product: "whisper", planId: "standard", productPayload: burnCiphertext, whisperReadLimit: 12, whisperRevealAt: null });
		for (const invalidReadLimit of ["0", "43", "1.5", "not-a-number"]) {
			const invalid = await burnApp.inject({ method: "POST", url: "/api/payments/whisper", headers: { "idempotency-key": `idempotency-whisper-invalid-${invalidReadLimit}`, "x-whisper-plan": "standard", "x-whisper-read-limit": invalidReadLimit, "content-type": "application/octet-stream" }, payload: burnCiphertext });
			expect(invalid.statusCode).toBe(400);
		}
		expect(burnCalls).toHaveLength(3);
		await burnApp.close();

		const calls: unknown[] = [];
		const quote: PaymentQuote = { orderId: "order-whisper-large", product: "whisper", planId: "spark", amountSats: 42, bolt11: "lnbc42n1large", paymentHash: "c".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
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
		const quote: PaymentQuote = { orderId: "order-pulse", product: "pulse", planId: "standard", amountSats: 402, bolt11: "lnbc402n1pulse", paymentHash: "9".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
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
		const quote: PaymentQuote = { orderId: "order-long", product: "catch", planId: "long", amountSats: 4_002, bolt11: "lnbc4002n1long", paymentHash: "b".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() };
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
			quote: () => { quotes += 1; return Promise.resolve({ orderId: "order-rate", product: "catch", planId: "spark", amountSats: 42, bolt11: "lnbc42n1rate", paymentHash: "f".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString() }); },
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