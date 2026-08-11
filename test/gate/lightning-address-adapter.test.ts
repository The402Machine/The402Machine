import { createHash } from "node:crypto";

import { encode, sign } from "bolt11-ts";
import { describe, expect, it, vi } from "vitest";

import { LightningAddressAdapter } from "../../src/gate/lightning-address-adapter.js";

const paymentHash = "a".repeat(64);
const metadata = JSON.stringify([["text/plain", "Pay alice"]]);
const createLnurlInvoice = async (): Promise<string> => createLnurlInvoiceForHash(paymentHash);
const createLnurlInvoiceForHash = async (invoicePaymentHash: string): Promise<string> => {
	const unsigned = encode({
		network: "bitcoin",
		satoshis: 42,
		timestamp: Math.floor(Date.now() / 1_000),
		tags: [
			{ tagName: "payment_hash", data: invoicePaymentHash },
			{ tagName: "payment_secret", data: "b".repeat(64) },
			{ tagName: "purpose_commit_hash", data: createHash("sha256").update(metadata, "utf8").digest("hex") },
			{ tagName: "expire_time", data: 600 },
		],
	});
	return (await sign(unsigned, "1".repeat(64))).paymentRequest;
};

const publicAddress = () => Promise.resolve(["93.184.216.34"]);

describe("Lightning Address adapter", () => {
	it("resolves a Lightning Address and creates an exact LNURL-pay invoice", async () => {
		const invoice = await createLnurlInvoice();
		const fetchImplementation = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				callback: "https://wallet.example/lnurl/callback",
				minSendable: 1_000,
				maxSendable: 1_000_000,
				metadata,
				tag: "payRequest",
			}), { status: 200, headers: { "content-type": "application/json" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ pr: invoice, routes: [], verify: "https://wallet.example/lnurl/verify/order-1" }), { status: 200, headers: { "content-type": "application/json" } }));
		const adapter = new LightningAddressAdapter({ fetchImplementation, resolveHostname: publicAddress });

		const created = await adapter.createInvoice({ lightningAddress: "alice@wallet.example", amountSats: 42 });

		expect(created).toMatchObject({
			bolt11: invoice,
			paymentHash,
			amountSats: 42,
			network: "mainnet",
			verification: { type: "url", url: "https://wallet.example/lnurl/verify/order-1" },
		});
		expect(created.expiresAt).toBeInstanceOf(Date);
		expect(fetchImplementation.mock.calls.map(([url]) => typeof url === "string" ? url : url instanceof URL ? url.href : url.url)).toEqual([
			"https://wallet.example/.well-known/lnurlp/alice",
			"https://wallet.example/lnurl/callback?amount=42000",
		]);
	});

	it("falls back to payer preimage when the provider omits LUD-21 verify", async () => {
		const invoice = await createLnurlInvoice();
		const fetchImplementation = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ callback: "https://wallet.example/callback", minSendable: 42_000, maxSendable: 42_000, metadata, tag: "payRequest" }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ pr: invoice, routes: [] }), { status: 200 }));
		const adapter = new LightningAddressAdapter({ fetchImplementation, resolveHostname: publicAddress });

		expect((await adapter.createInvoice({ lightningAddress: "alice@wallet.example", amountSats: 42 })).verification).toEqual({ type: "payer-preimage" });
	});

	it("rejects an amount outside the recipient range before requesting an invoice", async () => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ callback: "https://wallet.example/callback", minSendable: 43_000, maxSendable: 100_000, metadata: JSON.stringify([["text/plain", "Pay"]]), tag: "payRequest" }), { status: 200 }));
		const adapter = new LightningAddressAdapter({ fetchImplementation, resolveHostname: publicAddress });

		await expect(adapter.createInvoice({ lightningAddress: "alice@wallet.example", amountSats: 42 })).rejects.toThrow(/outside recipient range/u);
		expect(fetchImplementation).toHaveBeenCalledOnce();
	});

	it.each([
		["private initial host", "alice@wallet.example", "https://wallet.example/callback", ["127.0.0.1"]],
		["private callback host", "alice@wallet.example", "http://127.0.0.1/callback", ["93.184.216.34"]],
	])("rejects SSRF through %s", async (_case, lightningAddress, callback, addresses) => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ callback, minSendable: 1_000, maxSendable: 100_000, metadata: JSON.stringify([["text/plain", "Pay"]]), tag: "payRequest" }), { status: 200 }));
		const adapter = new LightningAddressAdapter({ fetchImplementation, resolveHostname: () => Promise.resolve(addresses) });

		await expect(adapter.createInvoice({ lightningAddress, amountSats: 42 })).rejects.toThrow(/public HTTPS endpoint/u);
	});

	it("rejects provider redirects and oversized responses", async () => {
		const redirected = new LightningAddressAdapter({
			fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example" } })),
			resolveHostname: publicAddress,
		});
		await expect(redirected.createInvoice({ lightningAddress: "alice@wallet.example", amountSats: 42 })).rejects.toThrow(/redirect/u);

		const oversized = new LightningAddressAdapter({
			fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(70_000), { status: 200 })),
			resolveHostname: publicAddress,
		});
		await expect(oversized.createInvoice({ lightningAddress: "alice@wallet.example", amountSats: 42 })).rejects.toThrow(/too large/u);
	});

	it("verifies settlement only from a matching LUD-21 response", async () => {
		const invoice = await createLnurlInvoice();
		const preimage = "f".repeat(64);
		const matchingPaymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
		const matchingInvoice = await createLnurlInvoiceForHash(matchingPaymentHash);
		const fetchImplementation = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ settled: false, preimage: null, pr: invoice, status: "OK" }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ settled: true, preimage, pr: matchingInvoice, status: "OK" }), { status: 200 }));
		const adapter = new LightningAddressAdapter({ fetchImplementation, resolveHostname: publicAddress });
		const verification = { type: "url" as const, url: "https://wallet.example/verify/order-1" };

		expect(await adapter.verifyInvoice({ bolt11: invoice, paymentHash, amountSats: 42, verification })).toEqual({ settled: false });
		expect(await adapter.verifyInvoice({ bolt11: matchingInvoice, paymentHash: matchingPaymentHash, amountSats: 42, verification })).toEqual({ settled: true, preimage });
	});

	it("rejects a settled LUD-21 response whose preimage does not match the invoice", async () => {
		const invoice = await createLnurlInvoice();
		const adapter = new LightningAddressAdapter({ fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ settled: true, preimage: "f".repeat(64), pr: invoice, status: "OK" }), { status: 200 })), resolveHostname: publicAddress });
		await expect(adapter.verifyInvoice({ bolt11: invoice, paymentHash, amountSats: 42, verification: { type: "url", url: "https://wallet.example/verify/order-1" } })).rejects.toThrow(/preimage mismatch/u);
	});

	it("does not authorize a settled flag without a cryptographic preimage", async () => {
		const invoice = await createLnurlInvoice();
		const adapter = new LightningAddressAdapter({ fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ settled: true, preimage: null, pr: invoice, status: "OK" }), { status: 200 })), resolveHostname: publicAddress });
		await expect(adapter.verifyInvoice({ bolt11: invoice, paymentHash, amountSats: 42, verification: { type: "url", url: "https://wallet.example/verify/order-1" } })).rejects.toThrow(/cryptographic proof/u);
	});

	it("does not claim server-side verification for payer-proof invoices", async () => {
		const invoice = await createLnurlInvoice();
		const adapter = new LightningAddressAdapter({ fetchImplementation: vi.fn<typeof fetch>(), resolveHostname: publicAddress });
		expect(await adapter.verifyInvoice({ bolt11: invoice, paymentHash, amountSats: 42, verification: { type: "payer-preimage" } })).toEqual({ settled: false });
	});
});
