import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("public API documentation", () => {
	it("documents payment, settlement, ingestion, listing, pagination, and owner operations without secrets", async () => {
		const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
		for (const contract of [
			"POST /api/payments/catch",
			"POST /api/payments/whisper",
			"GET /api/payments/{orderId}",
			"GET /api/catalog",
			"POST|PUT|PATCH|DELETE|GET|HEAD|OPTIONS /c/{publicId}",
			"GET /api/catch/{publicId}",
			"GET /api/catch/{publicId}/events",
			"PATCH /api/catch/{publicId}/settings",
			"DELETE /api/catch/{publicId}/events/{eventId}",
			"DELETE /api/catch/{publicId}",
			"Idempotency-Key",
			"Authorization: Bearer",
			"cursor",
			"access=public|authenticated",
			"bodyEncoding",
			"GET /w/{publicId}",
			"AES-256-GCM",
			"X-Whisper-Plan",
		]) expect(html).toContain(contract);
		expect(html).not.toMatch(/catch_(?:own|ing)_[A-Za-z0-9_-]{20,}/u);
		expect(html).not.toMatch(/lnbc[0-9A-Za-z]{20,}/u);
	});
});
