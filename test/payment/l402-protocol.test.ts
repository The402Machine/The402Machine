import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createL402Challenge, verifyL402Authorization } from "../../src/payment/l402-protocol.js";

const preimage = Buffer.alloc(32, 5).toString("hex");
const paymentHash = createHash("sha256").update(Buffer.alloc(32, 5)).digest("hex");

describe("L402 compatibility adapter", () => {
	it("mints a canonical macaroon bound to the invoice and request", () => {
		const challenge = createL402Challenge({
			paymentHash,
			bolt11: "lnbc42n1l402",
			rootKey: Buffer.alloc(32, 9),
			tokenId: Buffer.alloc(32, 4),
			location: "the402machine.com",
			product: "pulse",
			planId: "spark",
			method: "POST",
			path: "/api/payments/pulse",
			body: Buffer.from('{"planId":"spark"}'),
			expiresAt: new Date("2026-07-25T12:05:00.000Z"),
		});

		expect(challenge.header).toBe(`L402 macaroon="${challenge.macaroon}", invoice="lnbc42n1l402"`);
		expect(challenge.macaroon).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(verifyL402Authorization({
			authorization: `L402 ${challenge.macaroon}:${preimage}`,
			rootKey: Buffer.alloc(32, 9),
			expectedPaymentHash: paymentHash,
			product: "pulse",
			planId: "spark",
			method: "POST",
			path: "/api/payments/pulse",
			body: Buffer.from('{"planId":"spark"}'),
			now: new Date("2026-07-25T12:04:00.000Z"),
		})).toEqual({ valid: true, preimage, paymentHash });
	});

	it("rejects tampering, a wrong preimage, another body and expiry", () => {
		const input = {
			paymentHash, bolt11: "lnbc42n1l402", rootKey: Buffer.alloc(32, 9), tokenId: Buffer.alloc(32, 4), location: "the402machine.com",
			product: "pulse" as const, planId: "spark" as const, method: "POST", path: "/api/payments/pulse", body: Buffer.from('{"planId":"spark"}'), expiresAt: new Date("2026-07-25T12:05:00.000Z"),
		};
		const challenge = createL402Challenge(input);
		const verify = (authorization: string, body = input.body, now = new Date("2026-07-25T12:04:00.000Z")) => verifyL402Authorization({ authorization, rootKey: input.rootKey, expectedPaymentHash: paymentHash, product: input.product, planId: input.planId, method: input.method, path: input.path, body, now });

		expect(verify(`L402 ${challenge.macaroon}:${Buffer.alloc(32, 6).toString("hex")}`)).toEqual({ valid: false, reason: "invalid-preimage" });
		expect(verify(`L402 ${challenge.macaroon}:${preimage}`, Buffer.from('{"planId":"long"}'))).toEqual({ valid: false, reason: "invalid-macaroon" });
		expect(verify(`L402 ${challenge.macaroon}:${preimage}`, input.body, new Date("2026-07-25T12:06:00.000Z"))).toEqual({ valid: false, reason: "expired" });
		expect(verify(`L402 ${challenge.macaroon.slice(0, -1)}A:${preimage}`)).toEqual({ valid: false, reason: "invalid-macaroon" });
	});
});
