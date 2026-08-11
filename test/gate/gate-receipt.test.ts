import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createGateReceipt, gateReceiptJwks, verifyGateReceipt } from "../../src/gate/gate-receipt.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "gate-beta-2026-08";
const now = new Date("2026-08-11T12:00:00.000Z");
const binding = { projectId: "gate_project_abc", routeId: "route-abc", method: "POST", path: "/v1/weather", bodyDigest: "a".repeat(64), amountSats: 42, paymentHash: "b".repeat(64), jti: "receipt_abcdefghijklmnopqrstuvwxyz123456" } as const;

describe("GATE signed receipts", () => {
	it("signs a short-lived authorization and verifies the exact request binding", () => {
		const receipt = createGateReceipt({ ...binding, issuer: "https://the402machine.com", privateKey, keyId, now, expiresAt: new Date(now.getTime() + 300_000) });
		const verified = verifyGateReceipt({ receipt, publicKey, issuer: "https://the402machine.com", keyId, expected: binding, now: new Date(now.getTime() + 1_000) });
		expect(verified.valid).toBe(true);
		if (verified.valid) expect(verified.claims).toMatchObject({ iss: "https://the402machine.com", aud: binding.projectId, route: binding.routeId, jti: binding.jti });
	});

	it.each([
		["project", { projectId: "other" }],
		["route", { routeId: "other" }],
		["method", { method: "GET" }],
		["path", { path: "/v1/other" }],
		["body", { bodyDigest: "c".repeat(64) }],
		["amount", { amountSats: 43 }],
		["payment", { paymentHash: "d".repeat(64) }],
		["jti", { jti: "receipt_other_abcdefghijklmnopqrstuvwxyz" }],
	])("rejects a mismatched %s binding", (_name, mismatch) => {
		const receipt = createGateReceipt({ ...binding, issuer: "https://the402machine.com", privateKey, keyId, now, expiresAt: new Date(now.getTime() + 300_000) });
		expect(verifyGateReceipt({ receipt, publicKey, issuer: "https://the402machine.com", expected: { ...binding, ...mismatch }, now }).valid).toBe(false);
	});

	it("rejects expiry, a wrong issuer, signing key and key identifier", () => {
		const receipt = createGateReceipt({ ...binding, issuer: "https://the402machine.com", privateKey, keyId, now, expiresAt: new Date(now.getTime() + 1_000) });
		expect(verifyGateReceipt({ receipt, publicKey, issuer: "https://the402machine.com", keyId, expected: binding, now: new Date(now.getTime() + 1_001) }).valid).toBe(false);
		expect(verifyGateReceipt({ receipt, publicKey, issuer: "https://other.example", keyId, expected: binding, now }).valid).toBe(false);
		const other = generateKeyPairSync("ed25519");
		expect(verifyGateReceipt({ receipt, publicKey: other.publicKey, issuer: "https://the402machine.com", keyId, expected: binding, now }).valid).toBe(false);
		expect(verifyGateReceipt({ receipt, publicKey, issuer: "https://the402machine.com", keyId: "other-key", expected: binding, now }).valid).toBe(false);
	});

	it("rejects otherwise valid receipts whose lifetime exceeds five minutes", () => {
		const receipt = createGateReceipt({ ...binding, issuer: "https://the402machine.com", privateKey, keyId, now, expiresAt: new Date(now.getTime() + 301_000) });
		expect(verifyGateReceipt({ receipt, publicKey, issuer: "https://the402machine.com", keyId, expected: binding, now: new Date(now.getTime() + 1_000) })).toEqual({ valid: false });
	});

	it("publishes only the Ed25519 public key as JWKS", () => {
		const jwks = gateReceiptJwks({ publicKey, keyId });
		expect(jwks).toMatchObject({ keys: [{ kty: "OKP", crv: "Ed25519", kid: keyId, use: "sig", alg: "EdDSA" }] });
		expect(Object.hasOwn(jwks.keys[0]!, "d")).toBe(false);
	});
});
