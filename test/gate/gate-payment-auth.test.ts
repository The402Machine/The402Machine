import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createGatePaymentChallenge, verifyGatePaymentCredential } from "../../src/gate/gate-payment-auth.js";

const secret = Buffer.alloc(32, 7);
const preimage = "11".repeat(32);
const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const body = Buffer.from('{"city":"Madrid"}');
const challenge = createGatePaymentChallenge({ intentId: "gate_intent_1234567890abcdef", amountSats: 42, bolt11: "lnbc42gate", paymentHash, realm: "the402machine.com", targetMethod: "POST", targetPath: "/v1/weather", targetBody: body, expiresAt: new Date(Date.now() + 60_000), secret });
const authorization = `Payment ${Buffer.from(JSON.stringify({ challenge: challenge.parameters, payload: { preimage } }), "utf8").toString("base64url")}`;

describe("GATE Payment Authentication", () => {
	it("binds the credential to intent, target method, path and exact body bytes", () => {
		expect(verifyGatePaymentCredential({ authorization, intentId: "gate_intent_1234567890abcdef", targetMethod: "POST", targetPath: "/v1/weather", targetBody: body, secret, now: new Date() })).toMatchObject({ valid: true, preimage, paymentHash });
		for (const changed of [
			{ intentId: "gate_intent_other_1234567890", targetMethod: "POST", targetPath: "/v1/weather", targetBody: body },
			{ intentId: "gate_intent_1234567890abcdef", targetMethod: "GET", targetPath: "/v1/weather", targetBody: body },
			{ intentId: "gate_intent_1234567890abcdef", targetMethod: "POST", targetPath: "/v1/forecast", targetBody: body },
			{ intentId: "gate_intent_1234567890abcdef", targetMethod: "POST", targetPath: "/v1/weather", targetBody: Buffer.from('{"city":"Lisbon"}') },
		]) expect(verifyGatePaymentCredential({ authorization, ...changed, secret, now: new Date() })).toEqual({ valid: false, reason: "invalid-challenge" });
	});
});