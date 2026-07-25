import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	createPaymentChallenge,
	parsePaymentAuthorization,
	verifyPaymentCredential,
} from "../../src/payment/payment-protocol.js";

const quote = {
	orderId: "11111111-1111-4111-8111-111111111111",
	product: "pulse" as const,
	planId: "spark" as const,
	amountSats: 42,
	bolt11: "lnbc420n1synthetic",
	paymentHash: createHash("sha256").update(Buffer.alloc(32, 7)).digest("hex"),
	expiresAt: "2026-07-25T12:05:00.000Z",
};

describe("HTTP Payment Authentication over Lightning", () => {
	it("creates a deterministic bound Lightning charge challenge", () => {
		const challenge = createPaymentChallenge({
			quote,
			realm: "the402machine.com",
			method: "POST",
			path: "/api/payments/pulse",
			body: Buffer.from('{"planId":"spark"}'),
			expiresAt: new Date("2026-07-25T12:05:00.000Z"),
			secret: Buffer.alloc(32, 3),
		});

		expect(challenge.header).toMatch(/^Payment id="[A-Za-z0-9_-]{43}", realm="the402machine\.com", method="lightning", intent="charge", request="[A-Za-z0-9_-]+", digest="sha-256=:[A-Za-z0-9+/=]+:", expires="2026-07-25T12:05:00\.000Z", opaque="[A-Za-z0-9_-]+"$/u);
		expect(challenge.parameters.id).toHaveLength(43);
		expect(challenge.parameters.digest).toBe(`sha-256=:${createHash("sha256").update('{"planId":"spark"}').digest("base64")}:`);
		expect(JSON.parse(Buffer.from(challenge.parameters.request, "base64url").toString("utf8"))).toEqual({
			amount: "42",
			currency: "sat",
			description: "The402Machine PULSE Spark",
			externalId: quote.orderId,
			methodDetails: { invoice: quote.bolt11, network: "mainnet", paymentHash: quote.paymentHash },
		});
		expect(JSON.parse(Buffer.from(challenge.parameters.opaque, "base64url").toString("utf8"))).toEqual({ method: "POST", orderId: quote.orderId, path: "/api/payments/pulse" });
	});

	it("accepts a matching single-use preimage credential", () => {
		const body = Buffer.from('{"planId":"spark"}');
		const challenge = createPaymentChallenge({ quote, realm: "the402machine.com", method: "POST", path: "/api/payments/pulse", body, expiresAt: new Date("2026-07-25T12:05:00.000Z"), secret: Buffer.alloc(32, 3) });
		const credential = Buffer.from(JSON.stringify({ challenge: challenge.parameters, payload: { preimage: Buffer.alloc(32, 7).toString("hex") } }), "utf8").toString("base64url");

		expect(parsePaymentAuthorization(`Payment ${credential}`)).toEqual({ challenge: challenge.parameters, preimage: Buffer.alloc(32, 7).toString("hex") });
		expect(verifyPaymentCredential({ authorization: `Payment ${credential}`, expected: challenge.parameters, body, secret: Buffer.alloc(32, 3), now: new Date("2026-07-25T12:04:00.000Z") })).toEqual({ valid: true, paymentHash: quote.paymentHash });
	});

	it("rejects malformed, expired, body-mismatched and wrong-preimage credentials", () => {
		const body = Buffer.from('{"planId":"spark"}');
		const challenge = createPaymentChallenge({ quote, realm: "the402machine.com", method: "POST", path: "/api/payments/pulse", body, expiresAt: new Date("2026-07-25T12:05:00.000Z"), secret: Buffer.alloc(32, 3) });
		const encode = (preimage: string, parameters = challenge.parameters) => `Payment ${Buffer.from(JSON.stringify({ challenge: parameters, payload: { preimage } })).toString("base64url")}`;

		expect(verifyPaymentCredential({ authorization: "Payment not-json", expected: challenge.parameters, body, secret: Buffer.alloc(32, 3), now: new Date("2026-07-25T12:04:00.000Z") })).toEqual({ valid: false, reason: "malformed-credential" });
		expect(verifyPaymentCredential({ authorization: encode(Buffer.alloc(32, 7).toString("hex")), expected: challenge.parameters, body, secret: Buffer.alloc(32, 3), now: new Date("2026-07-25T12:06:00.000Z") })).toEqual({ valid: false, reason: "expired-invoice" });
		expect(verifyPaymentCredential({ authorization: encode(Buffer.alloc(32, 7).toString("hex")), expected: challenge.parameters, body: Buffer.from('{"planId":"long"}'), secret: Buffer.alloc(32, 3), now: new Date("2026-07-25T12:04:00.000Z") })).toEqual({ valid: false, reason: "invalid-challenge" });
		expect(verifyPaymentCredential({ authorization: encode(Buffer.alloc(32, 8).toString("hex")), expected: challenge.parameters, body, secret: Buffer.alloc(32, 3), now: new Date("2026-07-25T12:04:00.000Z") })).toEqual({ valid: false, reason: "invalid-preimage" });
	});
});
