import type { CatchPlanId } from "../domain/catch-plans.js";

export type PurchasableCatchPlanId = CatchPlanId;
export type PaymentProduct = "catch" | "whisper";
export type PaymentOrderStatus = "created" | "invoice_issued" | "paid" | "dispensed" | "expired" | "failed";

export const CATCH_PRICES_SATS: Readonly<Record<PurchasableCatchPlanId, number>> = Object.freeze({
	spark: 42,
	standard: 402,
	long: 4_002,
});

export const WHISPER_PRICES_SATS: Readonly<Record<PurchasableCatchPlanId, number>> = CATCH_PRICES_SATS;

export function priceForProduct(_product: PaymentProduct, planId: PurchasableCatchPlanId): number {
	return CATCH_PRICES_SATS[planId];
}

export type PaymentOrder = {
	id: string;
	idempotencyKey: string;
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	productPayload: Buffer | null;
	whisperReadLimit: number | null;
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
	whisperReadLimit?: number | null;
	createdAt: Date;
}): PaymentOrder {
	return {
		id: input.id,
		idempotencyKey: input.idempotencyKey,
		product: input.product,
		planId: input.planId,
		productPayload: input.productPayload,
		whisperReadLimit: input.whisperReadLimit ?? null,
		createdAt: input.createdAt,
		amountSats: priceForProduct(input.product, input.planId),
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
