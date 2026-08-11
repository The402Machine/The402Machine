import { createHash, randomBytes, type KeyObject } from "node:crypto";

import { validateGateRequestBinding, type GateMethod } from "./gate-domain.js";
import { createGateReceipt } from "./gate-receipt.js";
import type { GateAuthorization, GateIntent, GateRoute } from "./gate-repository.js";
import type { GateLightningInvoice, GateInvoiceVerification, LightningAddressAdapter } from "./lightning-address-adapter.js";

const GATE_SETTLEMENT_GRACE_MS = 5 * 60_000;

export interface GateServiceRepository {
	getRouteForProject(projectId: string, routeKey: string): Promise<GateRoute | null>;
	createIntent(input: { publicId: string; projectId: string; routeId: string; idempotencyKey: string; method: GateMethod; path: string; bodyDigest: string; amountSats: number; lightningAddress: string }): Promise<GateIntent>;
	claimInvoiceIssuance(intentId: string): Promise<GateIntent | null>;
	attachInvoice(intentId: string, invoice: { bolt11: string; paymentHash: string; expiresAt: Date; verifyUrl: string | null }): Promise<GateIntent>;
	markInvoiceUncertain(intentId: string): Promise<GateIntent>;
	getIntent(intentId: string): Promise<GateIntent | null>;
	markPaid(intentId: string, paidAt: Date): Promise<GateIntent | null>;
	getAuthorization(intentId: string): Promise<GateAuthorization | null>;
	authorizeIntent(input: { intentId: string; receiptJti: string; now: Date; createReceipt(receiptJti: string, projectPublicId: string): string }): Promise<GateAuthorization>;
}

type LightningPort = Pick<LightningAddressAdapter, "createInvoice" | "verifyInvoice">;

type GateServiceOptions = {
	repository: GateServiceRepository;
	lightning: LightningPort;
	receipt: { issuer: string; privateKey: KeyObject; publicKey: KeyObject; keyId: string };
	now?: () => Date;
};

export type GateQuote = { intentId: string; amountSats: number; bolt11: string; paymentHash: string; expiresAt: string; verification: "payer-preimage" | "url" };
export type GateAuthorizationResult = { authorized: true; receipt: string; source: GateAuthorization["source"] } | { authorized: false; state: GateIntent["state"] };

export class GateService {
	readonly #repository: GateServiceRepository;
	readonly #lightning: LightningPort;
	readonly #receipt: GateServiceOptions["receipt"];
	readonly #now: () => Date;

	public constructor(options: GateServiceOptions) {
		this.#repository = options.repository;
		this.#lightning = options.lightning;
		this.#receipt = options.receipt;
		this.#now = options.now ?? (() => new Date());
	}

	public async quote(input: { publicId: string; projectId: string; routeKey: string; idempotencyKey: string; method: string; path: string; body: Buffer; lightningAddress: string }): Promise<GateQuote> {
		const route = await this.#repository.getRouteForProject(input.projectId, input.routeKey);
		if (route === null || !route.active) throw new Error("GATE route not found");
		const binding = validateGateRequestBinding({ method: input.method, path: input.path, body: input.body });
		if (binding.method !== route.method || binding.path !== route.path) throw new Error("GATE request does not match route policy");
		const intent = await this.#repository.createIntent({ publicId: input.publicId, projectId: input.projectId, routeId: route.id, idempotencyKey: input.idempotencyKey, method: binding.method, path: binding.path, bodyDigest: binding.bodyDigest, amountSats: route.priceSats, lightningAddress: input.lightningAddress });
		if (intent.state === "invoice_issued" && intent.bolt11 !== null && intent.paymentHash !== null && intent.invoiceExpiresAt !== null) return quoteFromIntent(intent);
		if (intent.state === "invoice_uncertain") throw new Error("GATE invoice outcome is uncertain");
		if (intent.state === "invoice_issuing") return this.#waitForInvoice(intent.id);
		if (intent.state !== "pending_invoice") throw new Error("GATE intent cannot issue an invoice");
		const claimed = await this.#repository.claimInvoiceIssuance(intent.id);
		if (claimed === null) return this.#waitForInvoice(intent.id);
		let invoice: GateLightningInvoice;
		try {
			invoice = await this.#lightning.createInvoice({ lightningAddress: intent.lightningAddress, amountSats: intent.amountSats });
		} catch (error) {
			if (isAmbiguousProviderFailure(error)) {
				await this.#repository.markInvoiceUncertain(intent.id);
				throw new Error("GATE invoice outcome is uncertain", { cause: error });
			}
			throw error;
		}
		const attached = await this.#repository.attachInvoice(intent.id, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, expiresAt: invoice.expiresAt, verifyUrl: invoice.verification.type === "url" ? invoice.verification.url : null });
		return quoteFromIntent(attached);
	}

	public async prove(input: { intentId: string; preimage: string }): Promise<GateAuthorizationResult> {
		if (!/^[a-f0-9]{64}$/u.test(input.preimage)) throw new Error("GATE preimage is invalid");
		const intent = await this.#requiredIntent(input.intentId);
		if (intent.state === "authorized" && intent.receipt !== null) return this.#existingAuthorization(intent);
		if (intent.paymentHash === null) throw new Error("GATE intent has no payment hash");
		const hash = createHash("sha256").update(Buffer.from(input.preimage, "hex")).digest("hex");
		if (hash !== intent.paymentHash) throw new Error("GATE preimage is invalid");
		return this.#settleAndAuthorize(intent);
	}

	public async poll(intentId: string): Promise<GateAuthorizationResult> {
		const intent = await this.#requiredIntent(intentId);
		if (intent.state === "authorized" && intent.receipt !== null) return this.#existingAuthorization(intent);
		if ((intent.state !== "invoice_issued" && intent.state !== "expired") || intent.bolt11 === null || intent.paymentHash === null || intent.invoiceExpiresAt === null) return { authorized: false, state: intent.state };
		if (intent.state === "expired" && this.#now().getTime() > intent.invoiceExpiresAt.getTime() + GATE_SETTLEMENT_GRACE_MS) return { authorized: false, state: intent.state };
		if (intent.verifyUrl === null) return { authorized: false, state: intent.state };
		const verification: GateInvoiceVerification = { type: "url", url: intent.verifyUrl };
		const result = await this.#lightning.verifyInvoice({ bolt11: intent.bolt11, paymentHash: intent.paymentHash, amountSats: intent.amountSats, verification });
		if (!result.settled) return { authorized: false, state: intent.state };
		return this.#settleAndAuthorize(intent);
	}

	async #settleAndAuthorize(intent: GateIntent): Promise<GateAuthorizationResult> {
		const settledAt = this.#now();
		const paid = intent.state === "paid" ? intent : await this.#repository.markPaid(intent.id, settledAt);
		if (paid === null || paid.paymentHash === null) throw new Error("GATE intent could not be marked paid");
		const authorization = await this.#repository.authorizeIntent({
			intentId: paid.id,
			receiptJti: randomBytes(32).toString("base64url"),
			now: settledAt,
			createReceipt: (receiptJti, projectPublicId) => createGateReceipt({ issuer: this.#receipt.issuer, privateKey: this.#receipt.privateKey, keyId: this.#receipt.keyId, now: settledAt, expiresAt: new Date(settledAt.getTime() + 5 * 60_000), projectId: projectPublicId, routeId: paid.routeId, method: paid.method, path: paid.path, bodyDigest: paid.bodyDigest, amountSats: paid.amountSats, paymentHash: paid.paymentHash!, jti: receiptJti }),
		});
		return { authorized: true, receipt: authorization.receipt, source: authorization.source };
	}

	async #waitForInvoice(intentId: string): Promise<GateQuote> {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const intent = await this.#requiredIntent(intentId);
			if (intent.state === "invoice_issued") return quoteFromIntent(intent);
			if (intent.state === "invoice_uncertain") throw new Error("GATE invoice outcome is uncertain");
			if (intent.state !== "invoice_issuing") throw new Error("GATE intent cannot issue an invoice");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("GATE invoice is still being issued");
	}

	async #existingAuthorization(intent: GateIntent): Promise<GateAuthorizationResult> {
		if (intent.receipt === null) throw new Error("GATE authorized intent is missing its receipt");
		const authorization = await this.#repository.getAuthorization(intent.id);
		if (authorization === null) throw new Error("GATE authorized intent is missing its authorization ledger entry");
		return { authorized: true, receipt: intent.receipt, source: authorization.source };
	}

	async #requiredIntent(intentId: string): Promise<GateIntent> {
		const intent = await this.#repository.getIntent(intentId);
		if (intent === null) throw new Error("GATE intent not found");
		return intent;
	}
}

function quoteFromIntent(intent: GateIntent): GateQuote {
	if (intent.bolt11 === null || intent.paymentHash === null || intent.invoiceExpiresAt === null) throw new Error("GATE intent invoice is incomplete");
	return { intentId: intent.id, amountSats: intent.amountSats, bolt11: intent.bolt11, paymentHash: intent.paymentHash, expiresAt: intent.invoiceExpiresAt.toISOString(), verification: intent.verifyUrl === null ? "payer-preimage" : "url" };
}

function isAmbiguousProviderFailure(error: unknown): boolean {
	return error instanceof TypeError || (error instanceof Error && /abort|connection|socket|reset|timeout|fetch failed/iu.test(error.message));
}
