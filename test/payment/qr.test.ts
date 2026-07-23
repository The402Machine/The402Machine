import { describe, expect, it } from "vitest";

import { renderQr } from "../../public/assets/qr.js";

describe("Lightning invoice QR", () => {
	it("renders the BOLT11 invoice locally without remote image services", () => {
		const svg = renderQr("lnbc42n1the402machineinvoice");

		expect(svg).toContain("<svg");
		expect(svg).toContain('aria-label="Lightning invoice QR code"');
		expect(svg).toContain('fill="#000"');
		expect(svg.match(/<rect /gu)?.length).toBeGreaterThan(100);
		expect(svg).not.toContain("<image");
		expect(svg).not.toContain("<script");
		expect(svg).not.toContain("lnbc42n1the402machineinvoice");
	});

	it("rejects empty or implausibly large invoice text", () => {
		expect(() => renderQr("")).toThrow(/invoice/i);
		expect(() => renderQr("x".repeat(8_001))).toThrow(/invoice/i);
	});
});