import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("public API documentation", () => {
	it("documents payment, settlement, ingestion, listing, pagination, and owner operations without secrets", async () => {
		const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
		for (const contract of [
			"POST /api/payments/catch",
			"POST /api/payments/whisper",
			"POST /api/payments/pulse",
			"GET /api/payments/{orderId}",
			"GET /api/catalog",
			"POST|PUT|PATCH|DELETE|GET|HEAD|OPTIONS /c/{publicId}",
			"GET /api/catch/{publicId}",
			"GET /api/catch/{publicId}/events",
			"DELETE /api/catch/{publicId}/events/{eventId}",
			"DELETE /api/catch/{publicId}",
			"Idempotency-Key",
			"Authorization: Bearer",
			"cursor",
			"access=public|authenticated",
			"bodyEncoding",
			"sourceIp",
			"ipLocation",
			"GET /w/{publicId}",
			"AES-256-GCM",
			"X-Whisper-Plan",
			"X-Whisper-Read-Limit: 1",
			"X-Whisper-Reveal-At",
			"POST /p/{publicId}",
			"GET /api/pulse/{publicId}",
			"PATCH /api/pulse/{publicId}",
			"DELETE /api/pulse/{publicId}",
		]) expect(html).toContain(contract);
		expect(html).toContain("accepted with or without the ingest token");
		expect(html).toContain("locally resolved approximate IP location");
		expect(html).not.toContain("enable public ingest");
		expect(html).not.toMatch(/catch_(?:own|ing)_[A-Za-z0-9_-]{20,}/u);
		expect(html).not.toMatch(/lnbc[0-9A-Za-z]{20,}/u);
	});
});
