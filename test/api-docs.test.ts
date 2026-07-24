import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ownerPulseStatus } from "../src/pulse/pulse-contract.js";
import type { PulseResource } from "../src/pulse/pulse-repository.js";

describe("public API documentation", () => {
	it("documents payment, settlement, ingestion, listing, pagination, and owner operations without secrets", async () => {
		const html = await readFile(new URL("../public/api.html", import.meta.url), "utf8");
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
			"X-Whisper-Read-Limit",
			"X-Whisper-Reveal-At",
			"POST /p/{publicId}",
			"GET /api/pulse/{publicId}",
			"PATCH /api/pulse/{publicId}",
			"DELETE /api/pulse/{publicId}",
		]) expect(html).toContain(contract);
		expect(html).toContain("accepted with or without the ingest token");
		expect(html).toContain("any whole number from 1 through the selected plan allowance");
		expect(html).toContain("locally resolved approximate IP location");
		expect(html).toContain("<code>Authorization: Bearer ***");
		expect(html).not.toContain("enable public ingest");
		expect(html).not.toContain("Authorization: Bearer *** Listing supports");
		expect(html).not.toMatch(/catch_(?:own|ing)_[A-Za-z0-9_-]{20,}/u);
		expect(html).not.toMatch(/lnbc[0-9A-Za-z]{20,}/u);
	});

	it("ships downloadable OpenAPI and Postman contracts for every public endpoint", async () => {
		const [openApiSource, postmanSource] = await Promise.all([
			readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
			readFile(new URL("../public/the402machine.postman_collection.json", import.meta.url), "utf8"),
		]);
		const openApi = JSON.parse(openApiSource) as {
			openapi?: string;
			paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
			components?: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
		};
		const postman = JSON.parse(postmanSource) as { info?: { _postman_id?: string; schema?: string }; variable?: { key?: string; value?: string }[]; item?: unknown[] };
		expect(openApi.openapi).toBe("3.1.0");
		for (const [path, methods] of Object.entries({
			"/health": ["get"],
			"/api/catalog": ["get"],
			"/api/payments/catch": ["post"],
			"/api/payments/whisper": ["post"],
			"/api/payments/pulse": ["post"],
			"/api/payments/{orderId}": ["get"],
			"/c/{publicId}": ["get", "post", "put", "patch", "delete", "options"],
			"/api/catch/{publicId}": ["get", "delete"],
			"/api/catch/{publicId}/events": ["get"],
			"/api/catch/{publicId}/events/{eventId}": ["delete"],
			"/w/{publicId}": ["get"],
			"/p/{publicId}": ["post"],
			"/api/pulse/{publicId}": ["get", "patch", "delete"],
			"/api/pulse/public/{publicStatusId}": ["get"],
		})) for (const method of methods) expect(openApi.paths?.[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
		expect(openApi.components?.securitySchemes).toHaveProperty("bearerCapability");
		expect(openApi.paths?.["/api/catalog"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/Catalogue" });
		expect(openApi.paths?.["/api/catch/{publicId}"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/CatchStatus" });
		expect(openApi.paths?.["/api/catch/{publicId}/events"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/CatchEventPage" });
		expect(openApi.paths?.["/api/pulse/{publicId}"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/OwnerPulseStatus" });
		for (const schemaName of ["Catalogue", "CatchStatus", "CatchEvent", "CatchEventPage", "OwnerPulseStatus"]) expect(openApi.components?.schemas).toHaveProperty(schemaName);
		const ownerPulseSchema = openApi.components?.schemas?.OwnerPulseStatus as { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> } | undefined;
		expect(ownerPulseSchema?.additionalProperties).toBe(false);
		expect(ownerPulseSchema?.required).toEqual(expect.arrayContaining(["name", "state", "publicId", "heartbeatCount", "expiresAt"]));
		expect(ownerPulseSchema?.properties).toHaveProperty("lastPingAt");
		expect(ownerPulseSchema?.properties).toHaveProperty("publicStatusEnabled");
		expect(ownerPulseSchema?.properties).toHaveProperty("publicStatusId");
		expect(ownerPulseSchema?.properties).toHaveProperty("heartbeatsRemaining");
		const ownerFixture: PulseResource = {
			id: "fixture", publicId: "pulse_abcdefghijklmnopqrstuv", publicStatusId: "pulse_status_zyxwvutsrqponmlkjihgfe", planId: "spark", status: "active",
			ownerTokenHash: "owner", pingTokenHash: "ping", heartbeatLimit: 1_202, heartbeatCount: 7, expectedIntervalSeconds: 300, graceSeconds: 600,
			name: "Backup heartbeat", description: "Nightly backup worker", publicStatusEnabled: true, lastPingAt: new Date("2026-07-24T10:05:00.000Z"), createdAt: new Date("2026-07-24T10:00:00.000Z"), expiresAt: new Date("2026-07-28T12:00:00.000Z"),
		};
		const ownerDto = ownerPulseStatus(ownerFixture, Date.parse("2026-07-24T10:06:00.000Z"));
		expect(Object.keys(ownerDto).sort()).toEqual(Object.keys(ownerPulseSchema?.properties ?? {}).sort());
		for (const requiredProperty of ownerPulseSchema?.required ?? []) expect(ownerDto).toHaveProperty(requiredProperty);
		expect(openApiSource).toContain('"enum": [\n              "waiting",\n              "operational"');
		expect(openApiSource).not.toContain('"waiting",\n              "healthy"');
		expect(postman.info?.schema).toContain("collection");
		expect(postman.info?._postman_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
		expect(postman.variable).toContainEqual(expect.objectContaining({ key: "baseUrl", value: "https://the402machine.com" }));
		expect(postman.variable).toContainEqual(expect.objectContaining({ key: "publicStatusId" }));
		expect(postman.item?.length).toBeGreaterThanOrEqual(5);
		const postmanRequests = flattenPostmanRequests(postman.item ?? []);
		expect(postmanRequests).toHaveLength(22);
		expect(postmanRequests.find((request) => request.name === "Public status")?.url?.raw).toBe("{{baseUrl}}/api/pulse/public/{{publicStatusId}}");
		const whisperQuote = postmanRequests.find((request) => request.name === "Quote WHISPER ciphertext");
		expect(whisperQuote?.header).toContainEqual(expect.objectContaining({ key: "X-Whisper-Reveal-At", disabled: true }));
		const listEventsUrl = postmanRequests.find((request) => request.name === "List events")?.url;
		expect(listEventsUrl?.raw).toBe("{{baseUrl}}/api/catch/{{publicId}}/events?limit=20&access=authenticated");
		expect(listEventsUrl?.query).toContainEqual({ key: "limit", value: "20" });
		expect(listEventsUrl?.query).toContainEqual({ key: "access", value: "authenticated" });
		expect(postmanRequests.find((request) => request.name === "Quote WHISPER ciphertext")?.body?.raw).toHaveLength(30);
		for (const source of [openApiSource, postmanSource]) {
			expect(source).not.toMatch(/catch_(?:own|ing)_[A-Za-z0-9_-]{20,}/u);
			expect(source).not.toMatch(/pulse_(?:own|ping)_[A-Za-z0-9_-]{20,}/u);
			expect(source).not.toMatch(/lnbc[0-9A-Za-z]{20,}/u);
		}
	});

	it("offers direct contract downloads and a browsable endpoint reference", async () => {
		const html = await readFile(new URL("../public/api.html", import.meta.url), "utf8");
		for (const contract of [
			'href="/openapi.json" download',
			'href="/the402machine.postman_collection.json" download',
			"OpenAPI 3.1",
			"Postman collection",
			"Base URL",
			"Authentication model",
			"Response codes",
			"Public endpoints",
		]) expect(html).toContain(contract);
	});

	it("keeps the documented 22-operation contract explicit instead of exposing generated HEAD siblings", async () => {
		const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
		expect(source).toContain("exposeHeadRoutes: false");
	});
});

type PostmanRequest = { name: string | undefined; url: { raw?: string; query?: { key?: string; value?: string }[] } | undefined; body: { raw?: string } | undefined; header: { key?: string; value?: string; disabled?: boolean }[] | undefined };

function flattenPostmanRequests(items: unknown[]): PostmanRequest[] {
	return items.flatMap<PostmanRequest>((item) => {
		if (typeof item !== "object" || item === null) return [] as PostmanRequest[];
		const record = item as { name?: string; request?: { url?: PostmanRequest["url"]; body?: PostmanRequest["body"]; header?: PostmanRequest["header"] }; item?: unknown[] };
		return record.request === undefined ? flattenPostmanRequests(record.item ?? []) : [{ name: record.name, url: record.request.url, body: record.request.body, header: record.request.header }];
	});
}
