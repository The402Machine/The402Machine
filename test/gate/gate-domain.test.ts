import { describe, expect, it } from "vitest";

import {
	GATE_FREE_AUTHORIZATIONS_PER_MONTH,
	GATE_GRANT_EXPIRY_DAYS,
	GATE_PACKS,
	calculateGateGrantExpiry,
	gateMonthKey,
	lightningAddressWellKnownUrl,
	normalizeLightningAddress,
	validateGateRequestBinding,
	validateGateRoute,
} from "../../src/gate/gate-domain.js";

describe("GATE entitlements and pricing", () => {
	it("defines the immutable beta entitlement catalogue", () => {
		expect(GATE_FREE_AUTHORIZATIONS_PER_MONTH).toBe(25);
		expect(GATE_GRANT_EXPIRY_DAYS).toBe(402);
		expect(GATE_PACKS).toEqual({
			spark: { id: "spark", authorizations: 420, priceSats: 42, transferable: false },
			standard: { id: "standard", authorizations: 4_200, priceSats: 402, transferable: false },
			long: { id: "long", authorizations: 42_000, priceSats: 4_002, transferable: false },
		});
	});

	it("expires grants 402 whole UTC days after purchase without mutating the input", () => {
		const purchasedAt = new Date("2026-01-01T12:34:56.789Z");

		expect(calculateGateGrantExpiry(purchasedAt).toISOString()).toBe("2027-02-07T12:34:56.789Z");
		expect(purchasedAt.toISOString()).toBe("2026-01-01T12:34:56.789Z");
		expect(() => calculateGateGrantExpiry(new Date("invalid"))).toThrow("valid purchase date");
	});

	it("uses the UTC calendar month as allowance key", () => {
		expect(gateMonthKey(new Date("2026-02-01T00:30:00.000+01:00"))).toBe("2026-01");
		expect(gateMonthKey(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12");
		expect(() => gateMonthKey(new Date("invalid"))).toThrow("valid date");
	});
});

describe("GATE Lightning Address validation", () => {
	it("normalizes valid LUD-16 addresses and derives an HTTPS well-known URL", () => {
		const address = normalizeLightningAddress("  Sats.Receiver+gate@Example.COM  ");

		expect(address).toBe("Sats.Receiver+gate@example.com");
		expect(lightningAddressWellKnownUrl(address)).toBe(
			"https://example.com/.well-known/lnurlp/Sats.Receiver%2Bgate",
		);
	});

	it.each([
		"",
		"alice",
		"alice@@example.com",
		"alice@example",
		"alice@127.0.0.1",
		"alice@localhost",
		"alice@example.com/path",
		"alice name@example.com",
	])("rejects unsafe or malformed Lightning Address %j", (address) => {
		expect(() => normalizeLightningAddress(address)).toThrow("Lightning Address");
	});
});

describe("GATE route and request binding validation", () => {
	it("accepts bounded fixed-price routes and canonical request bindings", () => {
		expect(validateGateRoute({ key: "weather-v1", method: "POST", path: "/v1/weather", priceSats: 42 })).toEqual({
			key: "weather-v1",
			method: "POST",
			path: "/v1/weather",
			priceSats: 42,
		});
		expect(validateGateRequestBinding({ method: "post", path: "/v1/weather", body: Buffer.from('{"city":"Madrid"}') })).toEqual({
			method: "POST",
			path: "/v1/weather",
			bodyDigest: "610355224bd06ae867a075c0725b00c812acd980ee8ecb7470f6b6ef4126783a",
		});
	});

	it.each(["OPTIONS", "CONNECT", "TRACE", "post ", "GET\n"])("rejects unsupported method %j", (method) => {
		expect(() => validateGateRoute({ key: "route", method, path: "/ok", priceSats: 1 })).toThrow("method");
	});

	it.each([
		{ key: "", method: "GET", path: "/ok", priceSats: 1 },
		{ key: "UPPER", method: "GET", path: "/ok", priceSats: 1 },
		{ key: "a".repeat(65), method: "GET", path: "/ok", priceSats: 1 },
		{ key: "route", method: "GET", path: "relative", priceSats: 1 },
		{ key: "route", method: "GET", path: "/a?query=forbidden", priceSats: 1 },
		{ key: "route", method: "GET", path: "/" + "a".repeat(513), priceSats: 1 },
		{ key: "route", method: "GET", path: "/ok", priceSats: 0 },
		{ key: "route", method: "GET", path: "/ok", priceSats: 1_000_001 },
		{ key: "route", method: "GET", path: "/ok", priceSats: 1.5 },
	])("rejects unsafe route %#", (route) => {
		expect(() => validateGateRoute(route)).toThrow();
	});

	it("binds only absolute query-free paths and computes a SHA-256 hex digest", () => {
		expect(() => validateGateRequestBinding({ method: "GET", path: "/resource?x=1", body: Buffer.alloc(0) })).toThrow("path");
		expect(() => validateGateRequestBinding({ method: "OPTIONS", path: "/resource", body: Buffer.alloc(0) })).toThrow("method");
		expect(validateGateRequestBinding({ method: "HEAD", path: "/resource", body: Buffer.alloc(0) }).bodyDigest).toBe(
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
	});
});
