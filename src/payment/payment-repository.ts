import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Sql, TransactionSql } from "postgres";

import { CATCH_PLANS } from "../domain/catch-plans.js";
import type { ProvisionInput } from "../storage/catch-repository.js";
import { CATCH_PRICES_SATS, type PaymentOrder, type PaymentOrderStatus, type PaymentProduct, type PurchasableCatchPlanId } from "./payment-domain.js";

type PaymentOrderRow = {
	id: string;
	idempotency_key: string;
	product: PaymentProduct;
	plan_id: PurchasableCatchPlanId;
	product_payload: Buffer | null;
	amount_sats: number;
	status: PaymentOrderStatus;
	payment_hash: string | null;
	resource_public_id: string | null;
	created_at: Date;
	paid_at: Date | null;
	dispensed_at: Date | null;
};

type CatchDelivery = { product: "catch"; publicId: string; ownerToken: string; ingestToken: string; expiresAt: string };
type WhisperDelivery = { product: "whisper"; publicId: string; readToken: string; expiresAt: string };
type PaymentDelivery = CatchDelivery | WhisperDelivery;

export type DispensedResource =
	| { product: "catch"; resourceId: string; publicId: string; ownerToken: string; ingestToken: string; expiresAt: Date }
	| { product: "whisper"; resourceId: string; publicId: string; readToken: string; expiresAt: Date };

export type AtomicCatchProvision = ProvisionInput & { product: "catch"; ownerToken: string; ingestToken: string };
export type AtomicWhisperProvision = { product: "whisper"; publicId: string; planId: PurchasableCatchPlanId; readTokenHash: string; ciphertext: Buffer; readToken: string; expiresAt: Date };
export type AtomicProvision = AtomicCatchProvision | AtomicWhisperProvision;

export class PaymentRepository {
	private readonly deliveryKey: Buffer;

	public constructor(private readonly sql: Sql, deliveryKey: string) { this.deliveryKey = decodeDeliveryKey(deliveryKey); }

	public async createOrder(input: { idempotencyKey: string; product?: PaymentProduct; planId: PurchasableCatchPlanId; productPayload?: Buffer | null }): Promise<PaymentOrder> {
		if (!CATCH_PLANS[input.planId].available) throw new Error("Plan is not available");
		const product = input.product ?? "catch";
		const productPayload = input.productPayload ?? null;
		if (product === "catch" && productPayload !== null) throw new Error("CATCH orders cannot contain a product payload");
		if (product === "whisper" && (productPayload === null || productPayload.byteLength < 30 || productPayload.byteLength > 16 * 1024)) throw new Error("WHISPER ciphertext is invalid");
		const rows = await this.sql<PaymentOrderRow[]>`
			insert into payment_orders (idempotency_key, product, plan_id, product_payload, amount_sats)
			values (${input.idempotencyKey}, ${product}, ${input.planId}, ${productPayload}, ${CATCH_PRICES_SATS[input.planId]})
			on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
			returning *, null::text as resource_public_id
		`;
		const row = rows[0];
		if (row === undefined) throw new Error("Payment order creation returned no order");
		if (row.plan_id !== input.planId || row.product !== product || !buffersEqual(row.product_payload, productPayload)) throw new Error("Idempotency key already belongs to another purchase");
		return mapOrder(row);
	}

	public async attachInvoice(orderId: string, invoice: { paymentHash: string; bolt11: string }): Promise<PaymentOrder> {
		const rows = await this.sql<PaymentOrderRow[]>`
			update payment_orders set status = 'invoice_issued', payment_hash = ${invoice.paymentHash}, bolt11 = ${invoice.bolt11}, invoice_issued_at = clock_timestamp(), updated_at = clock_timestamp()
			where id = ${orderId} and status = 'created' returning *, null::text as resource_public_id
		`;
		const row = rows[0];
		if (row === undefined) throw new Error("Payment order is not awaiting an invoice");
		return mapOrder(row);
	}

	public async ensureInvoice(orderId: string, createInvoice: () => Promise<{ paymentHash: string; bolt11: string }>): Promise<PaymentOrder & { bolt11: string }> {
		return this.sql.begin(async (tx) => {
			const rows = await tx<(PaymentOrderRow & { bolt11: string | null })[]>`select *, null::text as resource_public_id from payment_orders where id = ${orderId} for update`;
			const row = rows[0];
			if (row === undefined) throw new Error("Payment order not found");
			if (row.payment_hash !== null && row.bolt11 !== null) return { ...mapOrder(row), bolt11: row.bolt11 };
			if (row.status !== "created") throw new Error("Payment order is not awaiting an invoice");
			const invoice = await createInvoice();
			const updated = await tx<(PaymentOrderRow & { bolt11: string })[]>`
				update payment_orders set status = 'invoice_issued', payment_hash = ${invoice.paymentHash}, bolt11 = ${invoice.bolt11}, invoice_issued_at = clock_timestamp(), updated_at = clock_timestamp()
				where id = ${orderId} and status = 'created' returning *, null::text as resource_public_id
			`;
			const invoiced = updated[0];
			if (invoiced === undefined) throw new Error("Could not attach payment invoice");
			return { ...mapOrder(invoiced), bolt11: invoiced.bolt11 };
		});
	}

	public async markPaid(orderId: string): Promise<PaymentOrder | null> {
		const rows = await this.sql<PaymentOrderRow[]>`
			update payment_orders set status = 'paid', paid_at = coalesce(paid_at, clock_timestamp()), updated_at = clock_timestamp()
			where id = ${orderId} and status = 'invoice_issued' returning *, null::text as resource_public_id
		`;
		return rows[0] === undefined ? null : mapOrder(rows[0]);
	}

	public async getOrder(orderId: string): Promise<(PaymentOrder & { bolt11: string | null }) | null> {
		const rows = await this.sql<(PaymentOrderRow & { bolt11: string | null })[]>`
			select o.*, coalesce(c.public_id, w.public_id) as resource_public_id from payment_orders o
			left join catch_resources c on o.product = 'catch' and c.id = o.resource_id
			left join whispers w on o.product = 'whisper' and w.id = o.resource_id
			where o.id = ${orderId}
		`;
		const row = rows[0];
		return row === undefined ? null : { ...mapOrder(row), bolt11: row.bolt11 };
	}

	public async dispensePaidOrder(orderId: string, provision: (order: PaymentOrder) => Promise<AtomicProvision>): Promise<DispensedResource | null> {
		return this.sql.begin(async (tx) => {
			const rows = await tx<(PaymentOrderRow & { delivery_ciphertext: Buffer | null; resource_id: string | null })[]>`
				select *, null::text as resource_public_id from payment_orders where id = ${orderId} for update
			`;
			const row = rows[0];
			if (row === undefined) return null;
			if (row.status === "dispensed") {
				if (row.resource_id === null || row.delivery_ciphertext === null) throw new Error("Dispensed order is incomplete");
				return deliveryResource(row.resource_id, decryptDelivery(row.delivery_ciphertext, this.deliveryKey));
			}
			if (row.status !== "paid") return null;
			const input = await provision(mapOrder(row));
			if (input.product !== row.product) throw new Error("Provisioned product does not match order");
			const resourceId = input.product === "catch" ? await insertCatch(tx, input) : await insertWhisper(tx, input);
			const delivery: PaymentDelivery = input.product === "catch"
				? { product: "catch", publicId: input.publicId, ownerToken: input.ownerToken, ingestToken: input.ingestToken, expiresAt: input.expiresAt.toISOString() }
				: { product: "whisper", publicId: input.publicId, readToken: input.readToken, expiresAt: input.expiresAt.toISOString() };
			const encryptedDelivery = encryptDelivery(delivery, this.deliveryKey);
			await tx`update payment_orders set status = 'dispensed', resource_id = ${resourceId}, delivery_ciphertext = ${encryptedDelivery}, product_payload = null, dispensed_at = clock_timestamp(), updated_at = clock_timestamp() where id = ${orderId} and status = 'paid'`;
			return deliveryResource(resourceId, delivery);
		});
	}
}

async function insertCatch(tx: TransactionSql, input: AtomicCatchProvision): Promise<string> {
	const rows = await tx<{ id: string }[]>`
		insert into catch_resources (public_id, plan_id, owner_token_hash, ingest_token_hash, request_limit, storage_limit_bytes, max_bytes_per_request, expires_at)
		values (${input.publicId}, ${input.planId}, ${input.ownerTokenHash}, ${input.ingestTokenHash}, ${input.requestLimit}, ${input.storageLimitBytes}, ${input.maxBytesPerRequest}, ${input.expiresAt}) returning id
	`;
	if (rows[0] === undefined) throw new Error("CATCH payment provisioning returned no resource");
	return rows[0].id;
}

async function insertWhisper(tx: TransactionSql, input: AtomicWhisperProvision): Promise<string> {
	const rows = await tx<{ id: string }[]>`
		insert into whispers (public_id, plan_id, read_token_hash, ciphertext, expires_at)
		values (${input.publicId}, ${input.planId}, ${input.readTokenHash}, ${input.ciphertext}, ${input.expiresAt}) returning id
	`;
	if (rows[0] === undefined) throw new Error("WHISPER payment provisioning returned no resource");
	return rows[0].id;
}

function mapOrder(row: PaymentOrderRow): PaymentOrder {
	return { id: row.id, idempotencyKey: row.idempotency_key, product: row.product, planId: row.plan_id, productPayload: row.product_payload, amountSats: row.amount_sats, status: row.status, paymentHash: row.payment_hash, resourcePublicId: row.resource_public_id, createdAt: row.created_at, paidAt: row.paid_at, dispensedAt: row.dispensed_at };
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean { return left === null || right === null ? left === right : left.equals(right); }
function decodeDeliveryKey(value: string): Buffer { const key = Buffer.from(value, "base64url"); if (key.byteLength !== 32) throw new Error("PAYMENT_DELIVERY_KEY must contain 32 base64url-encoded bytes"); return key; }
function encryptDelivery(delivery: PaymentDelivery, key: Buffer): Buffer { const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(delivery), "utf8"), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]); }
function decryptDelivery(payload: Buffer, key: Buffer): PaymentDelivery { if (payload.byteLength < 29) throw new Error("Stored payment delivery is invalid"); const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12)); decipher.setAuthTag(payload.subarray(12, 28)); const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")); if (!isPaymentDelivery(parsed)) throw new Error("Stored payment delivery is invalid"); return parsed; }
function isPaymentDelivery(value: unknown): value is PaymentDelivery { if (typeof value !== "object" || value === null) return false; const d = value as Record<string, unknown>; return d.product === "catch" ? typeof d.publicId === "string" && typeof d.ownerToken === "string" && typeof d.ingestToken === "string" && typeof d.expiresAt === "string" : d.product === "whisper" && typeof d.publicId === "string" && typeof d.readToken === "string" && typeof d.expiresAt === "string"; }
function deliveryResource(resourceId: string, delivery: PaymentDelivery): DispensedResource { return delivery.product === "catch" ? { product: "catch", resourceId, publicId: delivery.publicId, ownerToken: delivery.ownerToken, ingestToken: delivery.ingestToken, expiresAt: new Date(delivery.expiresAt) } : { product: "whisper", resourceId, publicId: delivery.publicId, readToken: delivery.readToken, expiresAt: new Date(delivery.expiresAt) }; }
