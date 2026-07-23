import type { PaymentAdapter, PaymentInvoice, PaymentVerification } from "./payment-adapter.js";

type LnbitsAdapterOptions = {
	baseUrl: string;
	invoiceKey: string;
	invoiceExpirySeconds?: number;
	fetchImplementation?: typeof fetch;
};

type LnbitsInvoiceResponse = { payment_hash?: unknown; payment_request?: unknown };
type LnbitsListedPayment = { payment_hash?: unknown; bolt11?: unknown; amount?: unknown; external_id?: unknown };
type LnbitsPaymentStatusResponse = {
	paid?: unknown;
	details?: { payment_hash?: unknown; amount?: unknown; amount_msat?: unknown };
};

export class LnbitsPaymentAdapter implements PaymentAdapter {
	private readonly baseUrl: string;
	private readonly invoiceKey: string;
	private readonly invoiceExpirySeconds: number;
	private readonly fetchImplementation: typeof fetch;

	public constructor(options: LnbitsAdapterOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
		if (!isPrivatePaymentBridgeUrl(this.baseUrl)) throw new Error("LNbits API URL must use the private payment bridge");
		if (options.invoiceKey.length === 0) throw new Error("LNbits invoice key is required");
		this.invoiceKey = options.invoiceKey;
		this.invoiceExpirySeconds = options.invoiceExpirySeconds ?? 600;
		this.fetchImplementation = options.fetchImplementation ?? fetch;
	}

	public async createInvoice(input: { amountSats: number; memo: string; orderId: string }): Promise<PaymentInvoice> {
		const response = await this.fetchImplementation(`${this.baseUrl}/api/v1/payments`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Api-Key": this.invoiceKey },
			body: JSON.stringify({
				out: false,
				amount: input.amountSats,
				unit: "sat",
				memo: input.memo,
				expiry: this.invoiceExpirySeconds,
				internal: false,
				extra: { order_id: input.orderId },
				external_id: input.orderId,
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`LNbits invoice creation failed with HTTP ${response.status}`);
		const payload = await response.json() as LnbitsInvoiceResponse;
		if (!isPaymentHash(payload.payment_hash) || typeof payload.payment_request !== "string" || payload.payment_request.length === 0) {
			throw new Error("LNbits returned an invalid invoice response");
		}
		return { paymentHash: payload.payment_hash, bolt11: payload.payment_request };
	}

	public async findInvoice(input: { orderId: string; amountSats: number }): Promise<PaymentInvoice | null> {
		const url = new URL(`${this.baseUrl}/api/v1/payments`);
		url.searchParams.set("external_id", input.orderId);
		url.searchParams.set("limit", "2");
		url.searchParams.set("sortby", "created_at");
		url.searchParams.set("direction", "desc");
		const response = await this.fetchImplementation(url, {
			headers: { "X-Api-Key": this.invoiceKey }, signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`LNbits invoice lookup failed with HTTP ${response.status}`);
		const payload = await response.json() as unknown;
		if (!Array.isArray(payload)) throw new Error("LNbits returned an invalid invoice lookup response");
		const matches = payload.filter((payment): payment is LnbitsListedPayment => isListedInvoice(payment, input));
		if (matches.length === 0) return null;
		if (matches.length > 1) throw new Error("LNbits returned multiple invoices for one order");
		const invoice = matches[0];
		if (invoice === undefined) throw new Error("LNbits invoice lookup was inconsistent");
		if (!isPaymentHash(invoice.payment_hash) || typeof invoice.bolt11 !== "string" || invoice.bolt11.length === 0) throw new Error("LNbits returned an invalid stored invoice");
		return { paymentHash: invoice.payment_hash, bolt11: invoice.bolt11 };
	}

	public async verifyInvoice(input: { paymentHash: string; amountSats: number }): Promise<PaymentVerification> {
		if (!isPaymentHash(input.paymentHash)) throw new Error("Invalid Lightning payment hash");
		const response = await this.fetchImplementation(`${this.baseUrl}/api/v1/payments/${input.paymentHash}`, {
			headers: { "X-Api-Key": this.invoiceKey },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`LNbits payment verification failed with HTTP ${response.status}`);
		const payload = await response.json() as LnbitsPaymentStatusResponse;
		if (payload.paid !== true) return { settled: false };
		const detailsHash = payload.details?.payment_hash;
		if (!isPaymentHash(detailsHash)) throw new Error("LNbits payment verification details are incomplete");
		if (detailsHash !== input.paymentHash) throw new Error("LNbits payment hash mismatch");
		const amountMsat = normalizedAmountMsat(payload.details);
		if (amountMsat === undefined) throw new Error("LNbits payment verification details are incomplete");
		if (amountMsat !== input.amountSats * 1_000) throw new Error("LNbits payment amount mismatch");
		return { settled: true };
	}
}

function normalizedAmountMsat(details: LnbitsPaymentStatusResponse["details"]): number | undefined {
	if (details === undefined) return undefined;
	if (typeof details.amount_msat === "number") return Math.abs(details.amount_msat);
	if (typeof details.amount === "number") return Math.abs(details.amount);
	return undefined;
}

function isPaymentHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isListedInvoice(value: unknown, input: { orderId: string; amountSats: number }): value is LnbitsListedPayment {
	if (typeof value !== "object" || value === null) return false;
	const payment = value as LnbitsListedPayment;
	return payment.external_id === input.orderId && typeof payment.amount === "number" && Math.abs(payment.amount) === input.amountSats * 1_000;
}

function isPrivatePaymentBridgeUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" && (
			url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" ||
			(url.hostname === "172.30.240.1" && url.port === "2180")
		);
	} catch {
		return false;
	}
}