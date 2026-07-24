import { describe, expect, it } from "vitest";

import type { PaymentAdapter } from "../../src/payment/payment-adapter.js";
import type { AtomicProvision, DispensedResource } from "../../src/payment/payment-repository.js";
import { PaymentService, type PaymentOrderStore } from "../../src/payment/payment-service.js";
import type { PaymentOrder, PaymentProduct, PurchasableCatchPlanId } from "../../src/payment/payment-domain.js";

class FakeOrderStore implements PaymentOrderStore {
	private readonly orders = new Map<string, PaymentOrder & { bolt11: string | null }>();
	public dispenseCalls = 0;

	public createOrder(input: { idempotencyKey: string; product?: PaymentProduct; planId: PurchasableCatchPlanId; productPayload?: Buffer | null; whisperReadLimit?: number | null; whisperRevealAt?: Date | null }): Promise<PaymentOrder> {
		const existing = [...this.orders.values()].find((order) => order.idempotencyKey === input.idempotencyKey);
		if (existing !== undefined) return Promise.resolve(existing);
		const order: PaymentOrder & { bolt11: string | null } = {
			id: `order-${this.orders.size + 1}`, idempotencyKey: input.idempotencyKey, product: input.product ?? "catch", planId: input.planId, productPayload: input.productPayload ?? null, whisperReadLimit: input.whisperReadLimit ?? null, whisperRevealAt: input.whisperRevealAt ?? null,
			amountSats: input.planId === "spark" ? 42 : input.planId === "standard" ? 402 : 4_002,
			status: "created", paymentHash: null, resourcePublicId: null, createdAt: new Date(), paidAt: null, dispensedAt: null, bolt11: null,
		};
		this.orders.set(order.id, order);
		return Promise.resolve(order);
	}

	public attachInvoice(orderId: string, invoice: { paymentHash: string; bolt11: string }): Promise<PaymentOrder> {
		const order = this.orders.get(orderId)!;
		Object.assign(order, { status: "invoice_issued", paymentHash: invoice.paymentHash, bolt11: invoice.bolt11 });
		return Promise.resolve(order);
	}
	public ensureInvoice(orderId: string, createInvoice: () => Promise<{ paymentHash: string; bolt11: string }>): Promise<PaymentOrder & { bolt11: string }> {
		const order = this.orders.get(orderId)!;
		if (order.paymentHash !== null && order.bolt11 !== null) return Promise.resolve({ ...order, bolt11: order.bolt11 });
		return createInvoice().then((invoice) => { Object.assign(order, { status: "invoice_issued", paymentHash: invoice.paymentHash, bolt11: invoice.bolt11 }); return { ...order, bolt11: invoice.bolt11 }; });
	}
	public getOrder(orderId: string): Promise<(PaymentOrder & { bolt11: string | null }) | null> { return Promise.resolve(this.orders.get(orderId) ?? null); }
	public markPaid(orderId: string): Promise<PaymentOrder | null> { const order = this.orders.get(orderId); if (order === undefined) return Promise.resolve(null); Object.assign(order, { status: "paid", paidAt: new Date() }); return Promise.resolve(order); }
	public dispensePaidOrder(orderId: string, provision: (order: PaymentOrder) => Promise<AtomicProvision>): Promise<DispensedResource | null> {
		this.dispenseCalls += 1;
		const order = this.orders.get(orderId);
		if (order === undefined) return Promise.resolve(null);
		if (order.status === "dispensed") return Promise.resolve({ product: "catch", resourceId: "resource-1", publicId: "catch_once", ownerToken: "owner-once", ingestToken: "ingest-once", expiresAt: new Date("2026-07-23T12:00:00.000Z") });
		if (order.status !== "paid") return Promise.resolve(null);
		return provision(order).then((resource) => {
			Object.assign(order, { status: "dispensed", resourcePublicId: resource.publicId });
			if (resource.product === "catch") return { product: "catch", resourceId: "resource-1", publicId: resource.publicId, ownerToken: resource.ownerToken, ingestToken: resource.ingestToken, expiresAt: resource.expiresAt };
			if (resource.product === "whisper") return { product: "whisper", resourceId: "resource-1", publicId: resource.publicId, readToken: resource.readToken, expiresAt: resource.expiresAt };
			return { product: "pulse", resourceId: "resource-1", publicId: resource.publicId, ownerToken: resource.ownerToken, pingToken: resource.pingToken, expiresAt: resource.expiresAt };
		});
	}
}

class FakeAdapter implements PaymentAdapter {
	public settled = false;
	public createCalls = 0;
	public createInvoice(): Promise<{ paymentHash: string; bolt11: string }> { this.createCalls += 1; return Promise.resolve({ paymentHash: "a".repeat(64), bolt11: "lnbc4n1test" }); }
	public findInvoice(): Promise<null> { return Promise.resolve(null); }
	public verifyInvoice(): Promise<{ settled: boolean }> { return Promise.resolve({ settled: this.settled }); }
}

const unusedProvisioner = () => Promise.reject<AtomicProvision>(new Error("not used"));

describe("PaymentService", () => {
	it("reuses an idempotent quote instead of creating duplicate invoices", async () => {
		const store = new FakeOrderStore(); const adapter = new FakeAdapter(); const service = new PaymentService(store, adapter, unusedProvisioner);
		const first = await service.quote({ idempotencyKey: "idempotency-1", product: "catch", planId: "spark", productPayload: null });
		const second = await service.quote({ idempotencyKey: "idempotency-1", product: "catch", planId: "spark", productPayload: null });
		expect(second).toEqual(first); expect(adapter.createCalls).toBe(1);
	});

	it("returns payment required until LNbits confirms settlement", async () => {
		const store = new FakeOrderStore(); const adapter = new FakeAdapter(); const service = new PaymentService(store, adapter, unusedProvisioner);
		const quote = await service.quote({ idempotencyKey: "idempotency-2", product: "catch", planId: "spark", productPayload: null });
		expect(await service.fulfill(quote.orderId)).toEqual({ settled: false }); expect(store.dispenseCalls).toBe(0);
	});

	it("dispenses one CATCH resource only after settlement", async () => {
		const store = new FakeOrderStore(); const adapter = new FakeAdapter(); adapter.settled = true;
		const provisioned = { product: "catch" as const, publicId: "catch_once", planId: "spark" as const, ownerTokenHash: "owner-hash", ingestTokenHash: "ingest-hash", requestLimit: 402, storageLimitBytes: 2 * 1024 * 1024, maxBytesPerRequest: 64 * 1024, ownerToken: "owner-once", ingestToken: "ingest-once", expiresAt: new Date("2026-07-23T12:00:00.000Z") };
		const service = new PaymentService(store, adapter, () => Promise.resolve(provisioned));
		const quote = await service.quote({ idempotencyKey: "idempotency-3", product: "catch", planId: "spark", productPayload: null });
		expect(await service.fulfill(quote.orderId)).toEqual({ settled: true, resource: { product: "catch", resourceId: "resource-1", publicId: "catch_once", ownerToken: "owner-once", ingestToken: "ingest-once", expiresAt: provisioned.expiresAt } });
	});
});
