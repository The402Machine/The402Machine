import type { PaymentAdapter } from "./payment-adapter.js";
import type { AtomicProvision, DispensedResource } from "./payment-repository.js";
import type { PaymentOrder, PaymentProduct, PurchasableCatchPlanId } from "./payment-domain.js";

export interface PaymentOrderStore {
	createOrder(input: { idempotencyKey: string; product?: PaymentProduct; planId: PurchasableCatchPlanId; productPayload?: Buffer | null }): Promise<PaymentOrder>;
	attachInvoice(orderId: string, invoice: { paymentHash: string; bolt11: string }): Promise<PaymentOrder>;
	ensureInvoice(orderId: string, createInvoice: () => Promise<{ paymentHash: string; bolt11: string }>): Promise<PaymentOrder & { bolt11: string }>;
	getOrder(orderId: string): Promise<(PaymentOrder & { bolt11: string | null }) | null>;
	markPaid(orderId: string): Promise<PaymentOrder | null>;
	dispensePaidOrder(orderId: string, provision: (order: PaymentOrder) => Promise<AtomicProvision>): Promise<DispensedResource | null>;
}

export type ProductProvisioner = (order: PaymentOrder) => Promise<AtomicProvision>;

export type PaymentQuote = {
	orderId: string;
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	amountSats: number;
	bolt11: string;
	paymentHash: string;
};

export class PaymentService {
	public constructor(private readonly orders: PaymentOrderStore, private readonly adapter: PaymentAdapter, private readonly provisionProduct: ProductProvisioner) {}

	public async quote(input: { idempotencyKey: string; product?: PaymentProduct; planId: PurchasableCatchPlanId; productPayload?: Buffer | null }): Promise<PaymentQuote> {
		const order = await this.orders.createOrder(input);
		const invoiced = await this.orders.ensureInvoice(order.id, async () => {
			const existing = await this.adapter.findInvoice({ orderId: order.id, amountSats: order.amountSats });
			return existing ?? this.adapter.createInvoice({
				amountSats: order.amountSats,
				memo: `The402Machine ${order.product.toUpperCase()} ${titleCase(order.planId)}`,
				orderId: order.id,
			});
		});
		return quoteResponse(invoiced, invoiced.bolt11);
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
}

function quoteResponse(order: PaymentOrder, bolt11: string): PaymentQuote {
	if (order.paymentHash === null) throw new Error("Invoiced order has no payment hash");
	return { orderId: order.id, product: order.product, planId: order.planId, amountSats: order.amountSats, bolt11, paymentHash: order.paymentHash };
}

function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
