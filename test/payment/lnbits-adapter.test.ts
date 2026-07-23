import { describe, expect, it, vi } from "vitest";

import { LnbitsPaymentAdapter } from "../../src/payment/lnbits-adapter.js";

describe("LNbits payment adapter", () => {
	it("creates a short-lived invoice with the invoice-only key", async () => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
			payment_hash: "a".repeat(64),
			payment_request: "lnbc4n1test",
		}), { status: 201, headers: { "content-type": "application/json" } }));
		const adapter = new LnbitsPaymentAdapter({
			baseUrl: "http://127.0.0.1:2180",
			invoiceKey: "invoice-key",
			invoiceExpirySeconds: 600,
			fetchImplementation,
		});

		const invoice = await adapter.createInvoice({ amountSats: 4, memo: "The402Machine CATCH Spark", orderId: "order-1" });
		expect(invoice).toEqual({ paymentHash: "a".repeat(64), bolt11: "lnbc4n1test" });
		expect(fetchImplementation).toHaveBeenCalledOnce();
		const [url, request] = fetchImplementation.mock.calls[0]!;
		expect(url).toBe("http://127.0.0.1:2180/api/v1/payments");
		expect(request?.headers).toEqual({ "Content-Type": "application/json", "X-Api-Key": "invoice-key" });
		if (typeof request?.body !== "string") throw new Error("Expected a JSON request body");
		expect(JSON.parse(request.body)).toEqual({
			out: false,
			amount: 4,
			unit: "sat",
			memo: "The402Machine CATCH Spark",
			expiry: 600,
			internal: false,
			extra: { order_id: "order-1" },
			external_id: "order-1",
		});
	});

	it("recovers an invoice by its stable LNbits external id", async () => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{
			payment_hash: "c".repeat(64), bolt11: "lnbc4n1recovered", amount: 4_000, external_id: "order-7",
		}]), { status: 200 }));
		const adapter = new LnbitsPaymentAdapter({ baseUrl: "http://127.0.0.1:2180", invoiceKey: "invoice-key", fetchImplementation });
		expect(await adapter.findInvoice({ orderId: "order-7", amountSats: 4 })).toEqual({ paymentHash: "c".repeat(64), bolt11: "lnbc4n1recovered" });
		const [url] = fetchImplementation.mock.calls[0]!;
		expect(url instanceof URL ? url.toString() : url).toContain("external_id=order-7");
	});

	it("looks up a prior provider invoice before creating one after an ambiguous failure", async () => {
		const fetchImplementation = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
			.mockRejectedValueOnce(new Error("connection reset after provider committed"))
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				payment_hash: "d".repeat(64), bolt11: "lnbc4n1recovered", amount: 4_000, external_id: "order-ambiguous",
			}]), { status: 200 }));
		const adapter = new LnbitsPaymentAdapter({ baseUrl: "http://127.0.0.1:2180", invoiceKey: "invoice-key", fetchImplementation });
		expect(await adapter.findInvoice({ orderId: "order-ambiguous", amountSats: 4 })).toBeNull();
		await expect(adapter.createInvoice({ orderId: "order-ambiguous", amountSats: 4, memo: "test" })).rejects.toThrow(/connection reset/);
		expect(await adapter.findInvoice({ orderId: "order-ambiguous", amountSats: 4 })).toEqual({ paymentHash: "d".repeat(64), bolt11: "lnbc4n1recovered" });
		expect(fetchImplementation).toHaveBeenCalledTimes(3);
	});

	it("verifies settlement server-side and rejects a mismatched payment hash", async () => {
		const fetchImplementation = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ paid: true, details: { payment_hash: "a".repeat(64), amount: 4_000 } }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ paid: true, details: { payment_hash: "b".repeat(64), amount: 4_000 } }), { status: 200 }));
		const adapter = new LnbitsPaymentAdapter({ baseUrl: "http://127.0.0.1:2180", invoiceKey: "invoice-key", fetchImplementation });

		expect(await adapter.verifyInvoice({ paymentHash: "a".repeat(64), amountSats: 4 })).toEqual({ settled: true });
		await expect(adapter.verifyInvoice({ paymentHash: "a".repeat(64), amountSats: 4 })).rejects.toThrow(/payment hash mismatch/);
	});

	it.each([
		["missing details", { paid: true }],
		["missing amount", { paid: true, details: { payment_hash: "a".repeat(64) } }],
		["missing hash", { paid: true, details: { amount: 4_000 } }],
		["wrong amount", { paid: true, details: { payment_hash: "a".repeat(64), amount: 42_000 } }],
	])("fails closed for a paid response with %s", async (_description, payload) => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
		const adapter = new LnbitsPaymentAdapter({ baseUrl: "http://127.0.0.1:2180", invoiceKey: "invoice-key", fetchImplementation });

		await expect(adapter.verifyInvoice({ paymentHash: "a".repeat(64), amountSats: 4 })).rejects.toThrow(/verification details|payment hash|payment amount/);
	});
});