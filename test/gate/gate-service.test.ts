import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { GateService, type GateServiceRepository } from "../../src/gate/gate-service.js";
import type { GateLightningInvoice } from "../../src/gate/lightning-address-adapter.js";
import type { GateAuthorization, GateIntent, GateRoute } from "../../src/gate/gate-repository.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const preimage = Buffer.alloc(32, 7).toString("hex");
const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const now = new Date("2026-08-11T12:00:00.000Z");
const expiresAt = new Date(now.getTime() + 600_000);
const route: GateRoute = { id: "route-id", projectId: "project-id", routeKey: "weather", method: "POST", path: "/v1/weather", priceSats: 42, active: true, createdAt: now, updatedAt: now };
const baseIntent: GateIntent = { id: "intent-id", publicId: "gate_intent_public", projectId: "project-id", routeId: route.id, idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", bodyDigest: "a".repeat(64), amountSats: 42, lightningAddress: "alice@example.com", state: "pending_invoice", bolt11: null, paymentHash: null, verifyUrl: null, receipt: null, invoiceExpiresAt: null, paidAt: null, authorizedAt: null, createdAt: now, updatedAt: now };
const invoice: GateLightningInvoice = { bolt11: "lnbc42gate", paymentHash, amountSats: 42, network: "mainnet", expiresAt, verification: { type: "payer-preimage" } };

function testRepository() {
	let intent = { ...baseIntent };
	let authorization: GateAuthorization | null = null;
	const getRouteForProject: GateServiceRepository["getRouteForProject"] = vi.fn(() => Promise.resolve(route));
	type CreateIntentInput = { publicId: string; projectId: string; routeId: string; idempotencyKey: string; method: "POST"; path: string; bodyDigest: string; amountSats: number; lightningAddress: string };
	type AttachInvoiceInput = { bolt11: string; paymentHash: string; expiresAt: Date; verifyUrl: string | null };
	type AuthorizeIntentInput = { intentId: string; receiptJti: string; now: Date; createReceipt: (receiptJti: string, projectPublicId: string) => string };
	const createIntent: GateServiceRepository["createIntent"] = vi.fn((input: CreateIntentInput) => {
		if (intent.idempotencyKey === input.idempotencyKey && intent.state !== "pending_invoice") return Promise.resolve(intent);
		intent = { ...baseIntent, ...input };
		return Promise.resolve(intent);
	});
	const claimInvoiceIssuance: GateServiceRepository["claimInvoiceIssuance"] = vi.fn(() => { if (intent.state !== "pending_invoice") return Promise.resolve(null); intent = { ...intent, state: "invoice_issuing" }; return Promise.resolve(intent); });
	const attachInvoice: GateServiceRepository["attachInvoice"] = vi.fn((_intentId: string, attached: AttachInvoiceInput) => { intent = { ...intent, state: "invoice_issued", bolt11: attached.bolt11, paymentHash: attached.paymentHash, verifyUrl: attached.verifyUrl, invoiceExpiresAt: attached.expiresAt }; return Promise.resolve(intent); });
	const markInvoiceUncertain: GateServiceRepository["markInvoiceUncertain"] = vi.fn(() => { intent = { ...intent, state: "invoice_uncertain" }; return Promise.resolve(intent); });
	const getIntent: GateServiceRepository["getIntent"] = vi.fn(() => Promise.resolve(intent));
	const markPaid: GateServiceRepository["markPaid"] = vi.fn((_intentId: string, paidAt: Date) => { intent = { ...intent, state: "paid", paidAt }; return Promise.resolve(intent); });
	const getAuthorization: GateServiceRepository["getAuthorization"] = vi.fn(() => Promise.resolve(authorization));
	const authorizeIntent: GateServiceRepository["authorizeIntent"] = vi.fn(({ receiptJti, now: authorizedAt, createReceipt }: AuthorizeIntentInput) => {
		const receipt = createReceipt(receiptJti, "gate_project_public");
		authorization ??= { id: "authorization-id", intentId: intent.id, receiptJti, receipt, source: "monthly_free", sourceMonth: new Date("2026-08-01T00:00:00Z"), grantId: null, consumedAt: authorizedAt, createdAt: authorizedAt };
		intent = { ...intent, state: "authorized", authorizedAt, paidAt: intent.paidAt ?? authorizedAt, receipt };
		return Promise.resolve(authorization);
	});
	const repository: GateServiceRepository = { getRouteForProject, createIntent, claimInvoiceIssuance, attachInvoice, markInvoiceUncertain, getIntent, markPaid, getAuthorization, authorizeIntent };
	return { repository, spies: { createIntent, markInvoiceUncertain, markPaid, authorizeIntent }, intent: () => intent, setIntent: (next: GateIntent) => { intent = next; } };
}

function service(repository: GateServiceRepository, adapter: { createInvoice: () => Promise<GateLightningInvoice>; verifyInvoice: () => Promise<{ settled: false } | { settled: true; preimage: string }> } = { createInvoice: vi.fn(() => Promise.resolve(invoice)), verifyInvoice: vi.fn(() => Promise.resolve({ settled: false as const })) }) {
	return { service: new GateService({ repository, lightning: adapter, receipt: { issuer: "https://the402machine.com", privateKey, publicKey, keyId: "gate-beta" }, now: () => now }), adapter };
}

describe("GateService", () => {
	it("binds signed receipts to the public project identifier", async () => {
		const { repository } = testRepository();
		const { service: gate } = service(repository);
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		const result = await gate.prove({ intentId: "intent-id", preimage });
		if (!result.authorized) throw new Error("Expected authorization");
		const claims = JSON.parse(Buffer.from(result.receipt.split(".")[1]!, "base64url").toString("utf8")) as { aud: string };
		expect(claims.aud).toBe("gate_project_public");
	});

	it("persists an intent before requesting one Lightning Address invoice", async () => {
		const { repository, spies } = testRepository();
		const { service: gate, adapter } = service(repository);
		const quote = await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		expect(spies.createIntent).toHaveBeenCalledBefore(vi.mocked(adapter.createInvoice));
		expect(quote).toMatchObject({ intentId: "intent-id", amountSats: 42, bolt11: invoice.bolt11, paymentHash, verification: "payer-preimage" });
	});

	it("coalesces concurrent idempotent quotes into one merchant invoice", async () => {
		const { repository } = testRepository();
		let releaseInvoice!: () => void;
		const waiting = new Promise<void>((resolve) => { releaseInvoice = resolve; });
		const adapter = { createInvoice: vi.fn(async () => { await waiting; return invoice; }), verifyInvoice: vi.fn(() => Promise.resolve({ settled: false as const })) };
		const gate = service(repository, adapter).service;
		const input = { publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-concurrent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" };
		const first = gate.quote(input);
		await vi.waitFor(() => expect(adapter.createInvoice).toHaveBeenCalledOnce());
		const second = gate.quote({ ...input, publicId: "gate_intent_other" });
		releaseInvoice();
		const [firstQuote, secondQuote] = await Promise.all([first, second]);
		expect(secondQuote).toEqual(firstQuote);
		expect(adapter.createInvoice).toHaveBeenCalledOnce();
	});

	it("marks an ambiguous provider failure and never retries inside one quote", async () => {
		const { repository, spies, intent } = testRepository();
		const adapter = { createInvoice: vi.fn(() => Promise.reject(new TypeError("connection reset after callback committed"))), verifyInvoice: vi.fn() };
		const gate = service(repository, adapter).service;
		await expect(gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" })).rejects.toThrow(/invoice outcome is uncertain/u);
		expect(adapter.createInvoice).toHaveBeenCalledOnce();
		expect(spies.markInvoiceUncertain).toHaveBeenCalledOnce();
		expect(intent().state).toBe("invoice_uncertain");
	});

	it("verifies a payer preimage, consumes one entitlement and returns a signed receipt", async () => {
		const { repository, spies } = testRepository();
		const { service: gate } = service(repository);
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		const result = await gate.prove({ intentId: "intent-id", preimage });
		expect(result).toMatchObject({ authorized: true, source: "monthly_free" });
		if (!result.authorized) throw new Error("Expected authorization");
		expect(result.receipt.split(".")).toHaveLength(3);
		expect(spies.markPaid).toHaveBeenCalledOnce();
		expect(spies.authorizeIntent).toHaveBeenCalledOnce();
	});

	it("replays the existing ledger source without consuming another authorization", async () => {
		const { repository, spies } = testRepository();
		const { service: gate } = service(repository);
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		await gate.prove({ intentId: "intent-id", preimage });
		const replay = await gate.prove({ intentId: "intent-id", preimage });
		expect(replay).toMatchObject({ authorized: true, source: "monthly_free" });
		expect(spies.authorizeIntent).toHaveBeenCalledOnce();
	});

	it("rejects an invalid preimage without consuming an authorization", async () => {
		const { repository, spies } = testRepository();
		const { service: gate } = service(repository);
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		await expect(gate.prove({ intentId: "intent-id", preimage: Buffer.alloc(32, 9).toString("hex") })).rejects.toThrow(/preimage is invalid/u);
		expect(spies.authorizeIntent).not.toHaveBeenCalled();
	});

	it("polls LUD-21 and authorizes only after validated settlement", async () => {
		const { repository } = testRepository();
		const urlInvoice: GateLightningInvoice = { ...invoice, verification: { type: "url", url: "https://wallet.example/verify/1" } };
		const adapter = { createInvoice: vi.fn(() => Promise.resolve(urlInvoice)), verifyInvoice: vi.fn().mockResolvedValueOnce({ settled: false }).mockResolvedValueOnce({ settled: true, preimage }) };
		const gate = service(repository, adapter).service;
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		expect(await gate.poll("intent-id")).toEqual({ authorized: false, state: "invoice_issued" });
		expect((await gate.poll("intent-id")).authorized).toBe(true);
	});

	it("polls an expired LUD-21 intent within settlement grace", async () => {
		const testState = testRepository();
		const expiredAt = new Date(now.getTime() - 60_000);
		const urlInvoice: GateLightningInvoice = { ...invoice, expiresAt: expiredAt, verification: { type: "url", url: "https://wallet.example/verify/grace" } };
		const adapter = { createInvoice: vi.fn(() => Promise.resolve(urlInvoice)), verifyInvoice: vi.fn(() => Promise.resolve({ settled: true as const, preimage })) };
		const gate = service(testState.repository, adapter).service;
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		testState.setIntent({ ...testState.intent(), state: "expired" });

		expect((await gate.poll("intent-id")).authorized).toBe(true);
		expect(adapter.verifyInvoice).toHaveBeenCalledOnce();
		expect(testState.spies.markPaid).toHaveBeenCalledOnce();
	});

	it("polls an expired LUD-21 intent at the exact settlement grace boundary", async () => {
		const testState = testRepository();
		const expiredAt = new Date(now.getTime() - 5 * 60_000);
		const urlInvoice: GateLightningInvoice = { ...invoice, expiresAt: expiredAt, verification: { type: "url", url: "https://wallet.example/verify/boundary" } };
		const adapter = { createInvoice: vi.fn(() => Promise.resolve(urlInvoice)), verifyInvoice: vi.fn(() => Promise.resolve({ settled: true as const, preimage })) };
		const gate = service(testState.repository, adapter).service;
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		testState.setIntent({ ...testState.intent(), state: "expired" });

		expect((await gate.poll("intent-id")).authorized).toBe(true);
		expect(adapter.verifyInvoice).toHaveBeenCalledOnce();
	});

	it("accepts a payer preimage for an expired intent within settlement grace", async () => {
		const testState = testRepository();
		const expiredAt = new Date(now.getTime() - 60_000);
		const preimageInvoice: GateLightningInvoice = { ...invoice, expiresAt: expiredAt };
		const gate = service(testState.repository, { createInvoice: vi.fn(() => Promise.resolve(preimageInvoice)), verifyInvoice: vi.fn(() => Promise.resolve({ settled: false as const })) }).service;
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		testState.setIntent({ ...testState.intent(), state: "expired" });

		expect((await gate.prove({ intentId: "intent-id", preimage })).authorized).toBe(true);
		expect(testState.spies.markPaid).toHaveBeenCalledOnce();
	});

	it("does not poll an expired LUD-21 intent after settlement grace", async () => {
		const testState = testRepository();
		const expiredAt = new Date(now.getTime() - 5 * 60_000 - 1);
		const urlInvoice: GateLightningInvoice = { ...invoice, expiresAt: expiredAt, verification: { type: "url", url: "https://wallet.example/verify/late" } };
		const adapter = { createInvoice: vi.fn(() => Promise.resolve(urlInvoice)), verifyInvoice: vi.fn(() => Promise.resolve({ settled: true as const, preimage })) };
		const gate = service(testState.repository, adapter).service;
		await gate.quote({ publicId: "gate_intent_public", projectId: "project-id", routeKey: "weather", idempotencyKey: "idempotency-intent", method: "POST", path: "/v1/weather", body: Buffer.from("{}"), lightningAddress: "alice@example.com" });
		testState.setIntent({ ...testState.intent(), state: "expired" });

		expect(await gate.poll("intent-id")).toEqual({ authorized: false, state: "expired" });
		expect(adapter.verifyInvoice).not.toHaveBeenCalled();
	});
});
