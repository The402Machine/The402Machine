import { describe, expect, it } from "vitest";

import {
	CATCH_PRICES_SATS,
	attachPaymentOrderInvoice,
	createPaymentOrder,
	markPaymentOrderDispensed,
	markPaymentOrderPaid,
	type PaymentOrder,
} from "../../src/payment/payment-domain.js";

const pendingOrder = (): PaymentOrder => createPaymentOrder({
	id: "order-1",
	idempotencyKey: "idem-1",
	product: "catch",
	planId: "spark",
	productPayload: null,
	createdAt: new Date("2026-07-23T08:00:00.000Z"),
});

describe("CATCH payment domain", () => {
	it("uses the tiny fixed-sats cartridge catalogue", () => {
		expect(CATCH_PRICES_SATS).toEqual({ spark: 4, standard: 42, long: 402 });
	});

	it("creates an unpaid order without granting a resource", () => {
		expect(pendingOrder()).toEqual({
			id: "order-1",
			idempotencyKey: "idem-1",
			product: "catch",
			planId: "spark",
			productPayload: null,
			amountSats: 4,
			status: "created",
			paymentHash: null,
			resourcePublicId: null,
			createdAt: new Date("2026-07-23T08:00:00.000Z"),
			paidAt: null,
			dispensedAt: null,
		});
	});

	it("allows only paid orders to be dispensed and never changes payment identity", () => {
		const order = pendingOrder();
		expect(() => markPaymentOrderDispensed(order, "catch_resource", new Date())).toThrow(/created -> dispensed/);

		const invoiced = attachPaymentOrderInvoice(order, "a".repeat(64));
		const paid = markPaymentOrderPaid(invoiced, "a".repeat(64), new Date("2026-07-23T08:01:00.000Z"));
		const dispensed = markPaymentOrderDispensed(paid, "catch_resource", new Date("2026-07-23T08:01:01.000Z"));
		expect(dispensed).toMatchObject({
			status: "dispensed",
			paymentHash: "a".repeat(64),
			resourcePublicId: "catch_resource",
		});
		expect(() => markPaymentOrderPaid(dispensed, "b".repeat(64), new Date())).toThrow(/dispensed -> paid/);
	});
});