import { createHash } from "node:crypto";

import type { PaymentAdapter } from "./payment-adapter.js";
import { validateBolt11 } from "./bolt11-validation.js";
import type { AtomicProvision, DispensedResource } from "./payment-repository.js";
import type { PaymentOrder, PaymentProduct, PurchasableCatchPlanId } from "./payment-domain.js";

export interface PaymentOrderStore {
	createOrder(input: { idempotencyKey: string; product?: PaymentProduct; planId: PurchasableCatchPlanId; productPayload?: Buffer | null; whisperReadLimit?: number | null; whisperRevealAt?: Date | null }): Promise<PaymentOrder>;
	ensureInvoice(orderId: string, createInvoice: () => Promise<{ paymentHash: string; bolt11: string }>): Promise<PaymentOrder & { bolt11: string }>;
	getOrder(orderId: string): Promise<(PaymentOrder & { bolt11: string | null }) | null>;
	markPaid(orderId: string): Promise<PaymentOrder | null>;
	dispensePaidOrder(orderId: string, provision: (order: PaymentOrder) => Promise<AtomicProvision>): Promise<DispensedResource | null>;
	consumePaymentChallengeAndDispense?(input: { challengeId: string; orderId: string; protocol: "payment" | "l402"; challengeFingerprint: string; paymentHash: string; expiresAt: Date }, provision: (order: PaymentOrder) => Promise<AtomicProvision>): Promise<{ consumed: true; resource: DispensedResource } | { consumed: false; reason: "replayed" | "mismatch" | "expired" | "unsettled" }>;
}

export type ProductProvisioner = (order: PaymentOrder) => Promise<AtomicProvision>;

export type PaymentQuote = {
	orderId: string;
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	amountSats: number;
	bolt11: string;
	paymentHash: string;
	network?: "mainnet" | "regtest" | "signet";
	expiresAt: string;
};

export class PaymentService {
	public constructor(private readonly orders: PaymentOrderStore, private readonly adapter: PaymentAdapter, private readonly provisionProduct: ProductProvisioner) {}

	public async quote(input: { idempotencyKey: string; product?: PaymentProduct; planId: PurchasableCatchPlanId; productPayload?: Buffer | null; whisperReadLimit?: number | null; whisperRevealAt?: Date | null }): Promise<PaymentQuote> {
		const order = await this.orders.createOrder(input);
		const invoiced = await this.orders.ensureInvoice(order.id, async () => {
			const existing = await this.adapter.findInvoice({ orderId: order.id, amountSats: order.amountSats });
			return existing ?? this.adapter.createInvoice({
				amountSats: order.amountSats,
				memo: `The402Machine ${order.product.toUpperCase()} ${titleCase(order.planId)}`,
				orderId: order.id,
			});
		});
		const invoice = await validateBolt11({ bolt11: invoiced.bolt11, expectedPaymentHash: invoiced.paymentHash ?? "", expectedAmountSats: invoiced.amountSats });
		return quoteResponse(invoiced, invoiced.bolt11, invoice.network, invoice.expiresAt);
	}

	public async fulfill(orderId: string): Promise<{ settled: false } | { settled: true; resource: DispensedResource }> {
		const order = await this.orders.getOrder(orderId);
		if (order === null || order.paymentHash === null) return { settled: false };
		if (order.status === "dispensed") {
			const resource = await this.orders.dispensePaidOrder(order.id, this.provisionProduct);
			return resource === null ? { settled: false } : { settled: true, resource };
		}
		const verification = await this.adapter.verifyInvoice({ paymentHash: order.paymentHash, amountSats: order.amountSats });
		if (!verification.settled) return { settled: false };
		const paid = order.status === "paid" ? order : await this.orders.markPaid(order.id);
		if (paid === null) return { settled: false };
		const resource = await this.orders.dispensePaidOrder(order.id, this.provisionProduct);
		return resource === null ? { settled: false } : { settled: true, resource };
	}

	public async fulfillWithPreimage(orderId: string, preimage: string): Promise<{ settled: false; reason: "invalid-preimage" | "unsettled" } | { settled: true; resource: DispensedResource }> {
		if (!/^[a-f0-9]{64}$/u.test(preimage)) return { settled: false, reason: "invalid-preimage" };
		const order = await this.orders.getOrder(orderId);
		if (order === null || order.paymentHash === null) return { settled: false, reason: "unsettled" };
		if (createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== order.paymentHash) return { settled: false, reason: "invalid-preimage" };
		const result = await this.fulfill(orderId);
		return result.settled ? result : { settled: false, reason: "unsettled" };
	}

	public async fulfillAgentPayment(input: { challengeId: string; orderId: string; protocol: "payment" | "l402"; challengeFingerprint: string; paymentHash: string; expiresAt: Date; preimage: string }): Promise<{ settled: true; resource: DispensedResource } | { settled: false; reason: "invalid-preimage" | "unsettled" | "replayed" | "mismatch" | "expired" }> {
		if (!/^[a-f0-9]{64}$/u.test(input.preimage) || input.expiresAt.getTime() <= Date.now()) return { settled: false, reason: input.expiresAt.getTime() <= Date.now() ? "expired" : "invalid-preimage" };
		const order = await this.orders.getOrder(input.orderId);
		if (order === null || order.paymentHash === null || order.paymentHash !== input.paymentHash) return { settled: false, reason: "mismatch" };
		if (createHash("sha256").update(Buffer.from(input.preimage, "hex")).digest("hex") !== order.paymentHash) return { settled: false, reason: "invalid-preimage" };
		const verification = await this.adapter.verifyInvoice({ paymentHash: order.paymentHash, amountSats: order.amountSats });
		if (!verification.settled) return { settled: false, reason: "unsettled" };
		if (order.status === "invoice_issued") await this.orders.markPaid(order.id);
		if (this.orders.consumePaymentChallengeAndDispense === undefined) return { settled: false, reason: "mismatch" };
		const consumed = await this.orders.consumePaymentChallengeAndDispense(input, this.provisionProduct);
		return consumed.consumed ? { settled: true, resource: consumed.resource } : { settled: false, reason: consumed.reason };
	}
}

function quoteResponse(order: PaymentOrder, bolt11: string, network: "mainnet" | "regtest" | "signet", invoiceExpiresAt: Date): PaymentQuote {
	if (order.paymentHash === null) throw new Error("Invoiced order has no payment hash");
	return { orderId: order.id, product: order.product, planId: order.planId, amountSats: order.amountSats, bolt11, paymentHash: order.paymentHash, network, expiresAt: new Date(Math.min(invoiceExpiresAt.getTime(), Date.now() + 10 * 60 * 1_000)).toISOString() };
}

function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
