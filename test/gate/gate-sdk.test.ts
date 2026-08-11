import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createGateReceipt } from "../../src/gate/gate-receipt.js";
import { createGateClient } from "../../src/gate/gate-sdk.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const issuer = "https://gate.example";
const keyId = "gate-beta";
const request = { method: "POST", path: "/v1/weather", body: Buffer.from('{"city":"Madrid"}'), idempotencyKey: "weather-request-1" } as const;

describe("GATE framework-neutral SDK", () => {
	it("strips spoofable GATE identity headers and forwards exact request bytes", async () => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ intentId: "intent-1", amountSats: 42, bolt11: "lnbc42", paymentHash: "a".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), verification: "payer-preimage" }), { status: 402, headers: { "content-type": "application/json", "www-authenticate": "Payment challenge" } }));
		const client = createGateClient({ gateBaseUrl: issuer, projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId, fetchImplementation });
		const result = await client.authorize({ ...request, headers: { "x-gate-project": "attacker", "gate-receipt": "spoof", "content-type": "application/json" } });
		expect(result.authorized).toBe(false);
		const [url, init] = fetchImplementation.mock.calls[0]!;
		expect(url instanceof URL ? url.href : typeof url === "string" ? url : url.url).toBe("https://gate.example/api/gate/intents");
		expect(Buffer.from(init?.body as Uint8Array)).toEqual(request.body);
		const headers = new Headers(init?.headers);
		expect(headers.get("x-gate-project")).toBe("gate_project_123");
		expect(headers.get("gate-receipt")).toBeNull();
		expect(headers.get("authorization")).toBe("Bearer gate_api_secret_123");
	});

	it("rejects a client configured without a usable persisted route identifier", () => {
		expect(() => createGateClient({ gateBaseUrl: "https://the402machine.com", projectId: `gate_project_${"p".repeat(24)}`, projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "", receiptPublicKey: publicKey, receiptKeyId: "gate-beta" })).toThrow(/route id/u);
	});

	it("supports local loopback development but rejects cleartext remote control planes", () => {
		expect(() => createGateClient({ gateBaseUrl: "http://127.0.0.1:4020", projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId })).not.toThrow();
		expect(() => createGateClient({ gateBaseUrl: "http://gate.example", projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId })).toThrow(/HTTPS/u);
	});

	it("submits payer proof for an existing intent and verifies the returned receipt", async () => {
		const bodyDigest = createHash("sha256").update(request.body).digest("hex");
		const receipt = createGateReceipt({ issuer, privateKey, keyId, now: new Date(), expiresAt: new Date(Date.now() + 300_000), projectId: "gate_project_123", routeId: "route-1", method: request.method, path: request.path, bodyDigest, amountSats: 42, paymentHash: "b".repeat(64), jti: "receipt_abcdefghijklmnopqrstuvwxyz123456" });
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ authorized: true, receipt, source: "monthly_free" }), { status: 200, headers: { "gate-receipt": receipt, "content-type": "application/json" } }));
		const client = createGateClient({ gateBaseUrl: issuer, projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId, fetchImplementation });
		const result = await client.prove({ intentId: "intent-1", preimage: "7".repeat(64), request });
		expect(result).toMatchObject({ authorized: true, receipt });
		const [url, init] = fetchImplementation.mock.calls[0]!;
		expect(url instanceof URL ? url.pathname : new URL(typeof url === "string" ? url : url.url).pathname).toBe("/api/gate/intents/intent-1/prove");
		expect(new Headers(init?.headers).get("x-gate-project")).toBe("gate_project_123");
	});

	it("polls an existing intent and preserves a pending 402 response", async () => {
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ authorized: false, state: "invoice_issued" }), { status: 402, headers: { "content-type": "application/json" } }));
		const client = createGateClient({ gateBaseUrl: issuer, projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId, fetchImplementation });
		const result = await client.poll({ intentId: "intent-1", request });
		expect(result).toMatchObject({ authorized: false, status: 402 });
	});

	it("returns the original 402 status, headers and body without inventing success", async () => {
		const responseBody = Buffer.from('{"amountSats":42}');
		const client = createGateClient({ gateBaseUrl: issuer, projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId, fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(responseBody, { status: 402, headers: { "www-authenticate": "Payment challenge", "content-type": "application/json" } })) });
		const result = await client.authorize(request);
		expect(result).toMatchObject({ authorized: false, status: 402 });
		if (result.authorized) throw new Error("Expected payment challenge");
		expect(result.headers.get("www-authenticate")).toBe("Payment challenge");
		expect(result.body).toEqual(responseBody);
	});

	it("verifies a successful Ed25519 receipt against the exact request binding", async () => {
		const bodyDigest = createHash("sha256").update(request.body).digest("hex");
		const receipt = createGateReceipt({ issuer, privateKey, keyId, now: new Date(), expiresAt: new Date(Date.now() + 300_000), projectId: "gate_project_123", routeId: "route-1", method: request.method, path: request.path, bodyDigest, amountSats: 42, paymentHash: "b".repeat(64), jti: "receipt_abcdefghijklmnopqrstuvwxyz123456" });
		const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ authorized: true, receipt, source: "monthly_free" }), { status: 200, headers: { "gate-receipt": receipt, "content-type": "application/json" } }));
		const client = createGateClient({ gateBaseUrl: issuer, projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId, fetchImplementation });
		const result = await client.authorize(request);
		expect(result).toMatchObject({ authorized: true, receipt });
	});

	it("fails closed for a receipt bound to another path or key identifier", async () => {
		const receipt = createGateReceipt({ issuer, privateKey, keyId: "other-key", now: new Date(), expiresAt: new Date(Date.now() + 300_000), projectId: "gate_project_123", routeId: "route-1", method: request.method, path: "/v1/other", bodyDigest: createHash("sha256").update(request.body).digest("hex"), amountSats: 42, paymentHash: "b".repeat(64), jti: "receipt_abcdefghijklmnopqrstuvwxyz123456" });
		const client = createGateClient({ gateBaseUrl: issuer, projectId: "gate_project_123", projectKey: "gate_api_secret_123", routeKey: "weather", routeId: "route-1", receiptPublicKey: publicKey, receiptKeyId: keyId, fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ authorized: true, receipt }), { status: 200, headers: { "gate-receipt": receipt } })) });
		await expect(client.authorize(request)).rejects.toThrow(/receipt verification failed/u);
	});
});
