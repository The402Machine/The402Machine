import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("CATCH configuration", () => {
	it("fails closed when provisioning is enabled without its required secrets and database", () => {
		expect(() => loadConfig({ CATCH_INTERNAL_PROVISIONING: "true" })).toThrow(/CATCH_PROVISIONING_SECRET/);
		expect(() => loadConfig({ CATCH_INTERNAL_PROVISIONING: "true", CATCH_PROVISIONING_SECRET: "secret" })).toThrow(/CATCH_TOKEN_PEPPER/);
		expect(() => loadConfig({ CATCH_INTERNAL_PROVISIONING: "true", CATCH_PROVISIONING_SECRET: "secret", CATCH_TOKEN_PEPPER: "pepper" })).toThrow(/DATABASE_URL/);
	});

	it("defaults provisioning off while accepting optional CATCH runtime configuration", () => {
		const config = loadConfig({ DATABASE_URL: "postgres://example", CATCH_TOKEN_PEPPER: "pepper", PUBLIC_BASE_URL: "https://catch.example" });
		expect(config.catch).toEqual({
			databaseUrl: "postgres://example",
			tokenPepper: "pepper",
			internalProvisioning: false,
			provisioningSecret: undefined,
			publicBaseUrl: "https://catch.example",
		});
		expect(config.trustedProxy).toBeUndefined();
	});

	it("accepts an explicit trusted reverse proxy address", () => {
		const config = loadConfig({ TRUSTED_PROXY: "127.0.0.1" });
		expect(config.trustedProxy).toBe("127.0.0.1");
	});

	it("fails closed when only one CATCH runtime credential is configured", () => {
		expect(() => loadConfig({ DATABASE_URL: "postgres://example" })).toThrow(/CATCH_TOKEN_PEPPER/);
		expect(() => loadConfig({ CATCH_TOKEN_PEPPER: "pepper" })).toThrow(/DATABASE_URL/);
	});

	it("enables payments only with loopback LNbits, an invoice key, and a 32-byte delivery key", () => {
		expect(() => loadConfig({ PAYMENT_PROVIDER: "lnbits" })).toThrow(/PAYMENT_API_URL/);
		expect(() => loadConfig({ PAYMENT_PROVIDER: "lnbits", PAYMENT_API_URL: "https://lnbits.example" })).toThrow(/private payment bridge/);
		expect(() => loadConfig({ PAYMENT_PROVIDER: "lnbits", PAYMENT_API_URL: "http://127.0.0.1:2180" })).toThrow(/PAYMENT_API_KEY/);
		expect(() => loadConfig({ PAYMENT_PROVIDER: "lnbits", PAYMENT_API_URL: "http://127.0.0.1:2180", PAYMENT_API_KEY: "invoice" })).toThrow(/PAYMENT_DELIVERY_KEY/);
		const config = loadConfig({
			DATABASE_URL: "postgres://example", CATCH_TOKEN_PEPPER: "pepper",
			PAYMENT_PROVIDER: "lnbits", PAYMENT_API_URL: "http://127.0.0.1:2180", PAYMENT_API_KEY: "invoice",
			PAYMENT_DELIVERY_KEY: Buffer.alloc(32, 1).toString("base64url"),
		});
		expect(config.payment.provider).toBe("lnbits");
	});

	it("accepts only loopback or the pinned Docker gateway for LNbits", () => {
		const base = {
			DATABASE_URL: "postgres://example", CATCH_TOKEN_PEPPER: "pepper", PAYMENT_PROVIDER: "lnbits",
			PAYMENT_API_KEY: "invoice", PAYMENT_DELIVERY_KEY: Buffer.alloc(32, 1).toString("base64url"),
		};
		expect(loadConfig({ ...base, PAYMENT_API_URL: "http://172.30.240.1:2180" }).payment.apiUrl).toBe("http://172.30.240.1:2180");
		expect(() => loadConfig({ ...base, PAYMENT_API_URL: "http://10.22.2.16:5000" })).toThrow(/private payment bridge/);
	});
});
