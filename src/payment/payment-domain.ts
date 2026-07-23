import type { CatchPlanId } from "../domain/catch-plans.js";

export type PurchasableCatchPlanId = CatchPlanId;
export type PaymentProduct = "catch" | "whisper";
export type PaymentOrderStatus = "created" | "invoice_issued" | "paid" | "dispensed" | "expired" | "failed";

export const CATCH_PRICES_SATS: Readonly<Record<PurchasableCatchPlanId, number>> = Object.freeze({
	spark: 4,
	standard: 42,
	long: 402,
});

export type PaymentOrder = {
	id: string;
	idempotencyKey: string;
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	productPayload: Buffer | null;
	amountSats: number;
	status: PaymentOrderStatus;
	paymentHash: string | null;
	resourcePublicId: string | null;
	createdAt: Date;
	paidAt: Date | null;
	dispensedAt: Date | null;
};

export function createPaymentOrder(input: {
	id: string;
	idempotencyKey: string;
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	productPayload: Buffer | null;
	createdAt: Date;
}): PaymentOrder {
	return {
		...input,
		amountSats: CATCH_PRICES_SATS[input.planId],
		status: "created",
		paymentHash: null,
		resourcePublicId: null,
		paidAt: null,
		dispensedAt: null,
	};
}

export function markPaymentOrderPaid(order: PaymentOrder, paymentHash: string, paidAt: Date): PaymentOrder {
	if (order.status !== "invoice_issued") throw illegalTransition(order.status, "paid");
	if (!/^[a-f0-9]{64}$/u.test(paymentHash)) throw new Error("Invalid Lightning payment hash");
	if (order.paymentHash !== paymentHash) throw new Error("Lightning payment hash changed");
	return { ...order, status: "paid", paymentHash, paidAt };
}

export function attachPaymentOrderInvoice(order: PaymentOrder, paymentHash: string): PaymentOrder {
	if (order.status !== "created") throw illegalTransition(order.status, "invoice_issued");
	if (!/^[a-f0-9]{64}$/u.test(paymentHash)) throw new Error("Invalid Lightning payment hash");
	return { ...order, status: "invoice_issued", paymentHash };
}

export function markPaymentOrderDispensed(order: PaymentOrder, resourcePublicId: string, dispensedAt: Date): PaymentOrder {
	if (order.status !== "paid") throw illegalTransition(order.status, "dispensed");
	return { ...order, status: "dispensed", resourcePublicId, dispensedAt };
}

function illegalTransition(from: PaymentOrderStatus, to: PaymentOrderStatus): Error {
	return new Error(`Illegal payment order transition: ${from} -> ${to}`);
}
