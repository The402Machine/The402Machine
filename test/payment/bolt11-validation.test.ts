import { createFakeInvoice } from "fake-bolt11";
import { describe, expect, it } from "vitest";

import { validateBolt11 } from "../../src/payment/bolt11-validation.js";

describe("BOLT11 validation", () => {
	it("verifies invoice hash, amount, network and expiry", async () => {
		const paymentHash = "a".repeat(64);
		const timestamp = 1_784_981_000;
		const result = await validateBolt11({ bolt11: createFakeInvoice(42, { paymentHash, expiry: 600, timestamp }), expectedPaymentHash: paymentHash, expectedAmountSats: 42 });
		expect(result).toEqual({ paymentHash, amountSats: 42, network: "mainnet", expiresAt: new Date((timestamp + 600) * 1_000) });
		expect((await validateBolt11({ bolt11: createFakeInvoice(42, { paymentHash, expiry: 600, timestamp, network: "bcrt" }), expectedPaymentHash: paymentHash, expectedAmountSats: 42 })).network).toBe("regtest");
	});
	it("rejects a mismatched amount and payment hash", async () => {
		const paymentHash = "b".repeat(64);
		const bolt11 = createFakeInvoice(42, { paymentHash });
		await expect(validateBolt11({ bolt11, expectedPaymentHash: paymentHash, expectedAmountSats: 43 })).rejects.toThrow("amount mismatch");
		await expect(validateBolt11({ bolt11, expectedPaymentHash: "c".repeat(64), expectedAmountSats: 42 })).rejects.toThrow("payment hash mismatch");
	});

	it("rejects an already expired invoice", async () => {
		const paymentHash = "d".repeat(64);
		const bolt11 = createFakeInvoice(42, { paymentHash, expiry: 60, timestamp: Math.floor(Date.now() / 1_000) - 61 });
		await expect(validateBolt11({ bolt11, expectedPaymentHash: paymentHash, expectedAmountSats: 42 })).rejects.toThrow("already expired");
	});
});
