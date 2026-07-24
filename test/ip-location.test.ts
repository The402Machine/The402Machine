import { describe, expect, it } from "vitest";

import { lookupIpLocally } from "../src/ip-location.js";

describe("local IP location", () => {
	it("looks up a public IPv4 locally without exposing third-party provider metadata", async () => {
		const location = await lookupIpLocally("8.8.8.8");
		expect(location).toMatchObject({ ip: "8.8.8.8", country: "US", source: "GeoLite2 (local)" });
		expect(location?.latitude).toEqual(expect.any(Number));
		expect(location?.longitude).toEqual(expect.any(Number));
	});

	it("does not geolocate private, documentation, or IPv6 addresses", async () => {
		for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "198.51.100.8", "203.0.113.7", "::1", "2001:4860:4860::8888"]) {
			await expect(lookupIpLocally(ip)).resolves.toBeUndefined();
		}
	});
});
