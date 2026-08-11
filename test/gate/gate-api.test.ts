import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { createGatePaymentChallenge } from "../../src/gate/gate-payment-auth.js";

const quote = { intentId: "intent-1", amountSats: 42, bolt11: "lnbc42gate", paymentHash: "a".repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(), verification: "payer-preimage" as const };
const optionalAuth = {
	authenticateProject: vi.fn((...credentials: [string, string]) => { expect(credentials).toHaveLength(2); return Promise.resolve({ id: "project-1", lightningAddress: "alice@example.com" }); }),
	projectOwnsIntent: vi.fn((projectId: string, intentId: string) => Promise.resolve(projectId === "project-1" && intentId === "intent-1")),
};

describe("GATE beta API", () => {
	it("keeps every GATE route absent when the feature is disabled", async () => {
		const app = buildApp();
		expect((await app.inject({ method: "POST", url: "/api/gate/intents" })).statusCode).toBe(404);
		expect((await app.inject({ method: "GET", url: "/.well-known/gate-jwks.json" })).statusCode).toBe(404);
		await app.close();
	});

	it("keeps polling and proof private to the owning project", async () => {
		const app = buildApp({ gate: { quote: () => Promise.resolve(quote), prove: () => Promise.reject(new Error("must not prove")), poll: () => Promise.reject(new Error("must not poll")), jwks: { keys: [] }, realm: "the402machine.com", protocolSecret: Buffer.alloc(32, 3), authenticateProject: (projectId: string, token: string) => Promise.resolve(projectId === "project-1" && token === "gate_api_secret_123" ? { id: "project-1", lightningAddress: "alice@example.com" } : null), projectOwnsIntent: (projectId: string, intentId: string) => Promise.resolve(projectId === "project-1" && intentId === "intent-1") } });
		expect((await app.inject({ method: "GET", url: "/api/gate/intents/intent-1" })).statusCode).toBe(401);
		expect((await app.inject({ method: "POST", url: "/api/gate/intents/intent-1/prove", headers: { "x-gate-project": "project-2", authorization: "Bearer gate_api_secret_123" }, payload: { preimage: "7".repeat(64) } })).statusCode).toBe(401);
		await app.close();
	});

	it("requires the project API capability and uses the stored Lightning Address", async () => {
		const calls: unknown[] = [];
		const app = buildApp({ gate: {
			quote: (input: unknown) => { calls.push(input); return Promise.resolve(quote); },
			prove: () => Promise.reject(new Error("not used")), poll: () => Promise.resolve({ authorized: false, state: "invoice_issued" }),
			jwks: { keys: [] }, realm: "the402machine.com", protocolSecret: Buffer.alloc(32, 3),
			authenticateProject: (projectId: string, token: string) => Promise.resolve(projectId === "project-1" && token === "gate_api_secret_123" ? { id: "project-1", lightningAddress: "alice@example.com" } : null),
			projectOwnsIntent: () => Promise.resolve(true),
		} });
		const body = Buffer.from('{"city":"Madrid"}');
		const headers = { "content-type": "application/json", "idempotency-key": "gate-idempotency-1", "x-gate-project": "project-1", "x-gate-route": "weather", "x-gate-method": "POST", "x-gate-path": "/v1/weather", "x-gate-lightning-address": "attacker@example.net", authorization: "Bearer gate_api_secret_123" };
		const response = await app.inject({ method: "POST", url: "/api/gate/intents", headers, payload: body });
		expect(response.statusCode).toBe(402);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.json()).toEqual(quote);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ projectId: "project-1", routeKey: "weather", idempotencyKey: "gate-idempotency-1", method: "POST", path: "/v1/weather", body, lightningAddress: "alice@example.com" });
		expect((calls[0] as { publicId: string }).publicId).toMatch(/^gate_intent_/u);
		const denied = await app.inject({ method: "POST", url: "/api/gate/intents", headers: { ...headers, authorization: "Bearer wrong" }, payload: body });
		expect(denied.statusCode).toBe(401);
		await app.close();
	});

	it("offers HTTP Payment Authentication and proves the original intent without a second quote", async () => {
		const preimage = Buffer.alloc(32, 7).toString("hex");
		const paymentHash = createHash("sha256").update(Buffer.alloc(32, 7)).digest("hex");
		const paymentQuote = { ...quote, paymentHash };
		let quoteCount = 0;
		const app = buildApp({ gate: {
			quote: () => { quoteCount += 1; return Promise.resolve(paymentQuote); }, prove: ({ preimage: received }: { intentId: string; preimage: string }) => Promise.resolve(received === preimage ? { authorized: true as const, receipt: "receipt.jwt.sig", source: "monthly_free" as const } : { authorized: false as const, state: "invoice_issued" as const }),
			poll: () => Promise.resolve({ authorized: false, state: "invoice_issued" }), jwks: { keys: [] }, realm: "the402machine.com", protocolSecret: Buffer.alloc(32, 3), ...optionalAuth,
		} });
		const body = Buffer.from('{"city":"Madrid"}');
		const headers = { "content-type": "application/json", "idempotency-key": "gate-idempotency-agent", "x-gate-project": "project-1", "x-gate-route": "weather", "x-gate-method": "POST", "x-gate-path": "/v1/weather", "x-payment-protocol": "payment", authorization: "Bearer gate_api_secret_123" };
		const challengeResponse = await app.inject({ method: "POST", url: "/api/gate/intents", headers, payload: body });
		expect(challengeResponse.statusCode).toBe(402);
		expect(challengeResponse.headers["www-authenticate"]).toMatch(/^Payment /u);
		const expected = createGatePaymentChallenge({ intentId: paymentQuote.intentId, amountSats: 42, bolt11: paymentQuote.bolt11, paymentHash, realm: "the402machine.com", targetMethod: "POST", targetPath: "/v1/weather", targetBody: body, expiresAt: new Date(paymentQuote.expiresAt), secret: Buffer.alloc(32, 3) });
		const authorization = `Payment ${Buffer.from(JSON.stringify({ challenge: expected.parameters, payload: { preimage } })).toString("base64url")}`;
		const authorized = await app.inject({ method: "POST", url: "/api/gate/intents/intent-1/prove", headers: { "content-type": "application/json", authorization, "x-gate-project": "project-1", "x-gate-project-key": "gate_api_secret_123", "x-gate-method": "POST", "x-gate-path": "/v1/weather" }, payload: body });
		expect(authorized.statusCode).toBe(200);
		expect(authorized.headers["gate-receipt"]).toBe("receipt.jwt.sig");
		expect(quoteCount).toBe(1);
		await app.close();
	});

	it("polls LUD-21 and accepts a direct preimage proof without leaking it", async () => {
		const prove = vi.fn(() => Promise.resolve({ authorized: true as const, receipt: "receipt.jwt.sig", source: "monthly_free" as const }));
		const poll = vi.fn(() => Promise.resolve({ authorized: false as const, state: "invoice_issued" as const }));
		const app = buildApp({ gate: { quote: () => Promise.resolve(quote), prove, poll, jwks: { keys: [] }, realm: "the402machine.com", protocolSecret: Buffer.alloc(32, 3), ...optionalAuth } });
		const projectHeaders = { "x-gate-project": "project-1", authorization: "Bearer gate_api_secret_123" };
		const pending = await app.inject({ method: "GET", url: "/api/gate/intents/intent-1", headers: projectHeaders });
		expect(pending.statusCode).toBe(402);
		const proven = await app.inject({ method: "POST", url: "/api/gate/intents/intent-1/prove", headers: projectHeaders, payload: { preimage: "7".repeat(64) } });
		expect(proven.statusCode).toBe(200);
		expect(proven.json()).toEqual({ authorized: true, receipt: "receipt.jwt.sig", source: "monthly_free" });
		expect(JSON.stringify(proven.json())).not.toContain("7".repeat(64));
		expect(prove).toHaveBeenCalledWith({ intentId: "intent-1", preimage: "7".repeat(64) });
		await app.close();
	});

	it("publishes the receipt JWKS with public caching", async () => {
		const jwks = { keys: [{ kty: "OKP", crv: "Ed25519", x: "public", kid: "gate-beta", use: "sig", alg: "EdDSA" }] };
		const app = buildApp({ gate: { quote: () => Promise.resolve(quote), prove: () => Promise.reject(new Error("unused")), poll: () => Promise.resolve({ authorized: false, state: "invoice_issued" }), jwks, realm: "the402machine.com", protocolSecret: Buffer.alloc(32, 3), ...optionalAuth } });
		const response = await app.inject({ method: "GET", url: "/.well-known/gate-jwks.json" });
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("public, max-age=300");
		expect(response.json()).toEqual(jwks);
		await app.close();
	});
});
