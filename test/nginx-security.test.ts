import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Nginx security boundary", () => {
	it("uses shared ingress rate-limit zones and overwrites forwarding headers", async () => {
		const [realIp, zones, site, proxy] = await Promise.all([
			readFile(new URL("../deploy/nginx/cloudflare-real-ip.conf", import.meta.url), "utf8"),
			readFile(new URL("../deploy/nginx/the402machine-rate-limits.conf", import.meta.url), "utf8"),
			readFile(new URL("../deploy/nginx/the402machine.com.conf", import.meta.url), "utf8"),
			readFile(new URL("../deploy/nginx/the402machine-proxy.conf", import.meta.url), "utf8"),
		]);

		expect(zones).toContain("limit_req_zone $binary_remote_addr zone=the402_owner");
		expect(zones).toContain("limit_req_zone $binary_remote_addr zone=the402_payment_quote");
		expect(zones).toContain("limit_req_zone $binary_remote_addr zone=the402_payment_check");
		expect(zones).toContain("limit_req_status 429");
		expect(realIp).toContain("set_real_ip_from 173.245.48.0/20;");
		expect(realIp).toContain("real_ip_header CF-Connecting-IP;");
		expect(site).toContain("location ^~ /api/catch/");
		expect(site).toContain("client_max_body_size 1m;");
		expect(site).toContain("location = /api/payments/whisper");
		expect(site).toContain("client_max_body_size 5m;");
		expect(site).toContain("limit_req zone=the402_owner");
		expect(site).toContain("location = /api/payments/catch");
		expect(site).toContain("location = /api/payments/pulse");
		expect(site).toContain("location ^~ /p/");
		expect(site).toContain("location ^~ /api/pulse/");
		expect(site).toContain("limit_req zone=the402_payment_quote");
		expect(site).toContain("location ^~ /api/payments/");
		expect(site).toContain("limit_req zone=the402_payment_check");
		expect(proxy).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
		expect(proxy).not.toContain("$proxy_add_x_forwarded_for");
	});
});
