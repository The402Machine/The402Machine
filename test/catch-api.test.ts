import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type CatchApiRepository } from "../src/app.js";
import { hashToken } from "../src/security/tokens.js";
import type { CatchResource } from "../src/storage/catch-repository.js";

const pepper = "test-pepper";
const provisioningSecret = "provisioning-secret";
const ownerToken = `catch_own_${"o".repeat(43)}`;
const ingestToken = `catch_ing_${"i".repeat(43)}`;

const resource = (): CatchResource => ({
	id: "resource-1",
	publicId: "catch_test-public-id",
	planId: "spark",
	status: "active",
	ingestAuthRequired: true,
	requestLimit: 402,
	storageLimitBytes: 2 * 1024 * 1024,
	maxBytesPerRequest: 64 * 1024,
	acceptedRequestCount: 1,
	storedBytes: 5,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	expiresAt: new Date("2026-01-01T04:02:00.000Z"),
});

class FakeCatchRepository implements CatchApiRepository {
	public readonly provisions: Parameters<CatchApiRepository["provision"]>[] = [];
	public readonly accepted: Parameters<CatchApiRepository["acceptEvent"]>[] = [];
	public readonly deletedEvents: string[] = [];
	public destroyed = false;
	public credentialLookups = 0;
	public ingestAuthRequired = true;
	public credentials = {
		ownerTokenHash: hashToken("owner", ownerToken, pepper),
		ingestTokenHash: hashToken("ingest", ingestToken, pepper),
	};

	public provision(input: Parameters<CatchApiRepository["provision"]>[0]): Promise<CatchResource> {
		this.provisions.push([input]);
		return Promise.resolve({ ...resource(), publicId: input.publicId, planId: input.planId, expiresAt: input.expiresAt });
	}

	public getResource(publicId: string): Promise<CatchResource | null> {
		return Promise.resolve(publicId === resource().publicId ? resource() : null);
	}

	public getCredentialHashes(publicId: string): Promise<{ ownerTokenHash: string | null; ingestTokenHash: string | null; ingestAuthRequired: boolean } | null> {
		this.credentialLookups += 1;
		return Promise.resolve(publicId === resource().publicId ? { ...this.credentials, ingestAuthRequired: this.ingestAuthRequired } : null);
	}

	public acceptEvent(input: Parameters<CatchApiRepository["acceptEvent"]>[0]): Promise<{ accepted: true; eventId: string; sequenceNumber: number }> {
		this.accepted.push([input]);
		return Promise.resolve({ accepted: true, eventId: "event-1", sequenceNumber: 1 });
	}

	public listEvents(): ReturnType<CatchApiRepository["listEvents"]> { return Promise.resolve({ events: [], nextCursor: null }); }
	public setIngestAuthRequired(_publicId: string, required: boolean): Promise<boolean> { this.ingestAuthRequired = required; return Promise.resolve(true); }
	public deleteEvent(_publicId: string, eventId: string): Promise<boolean> { this.deletedEvents.push(eventId); return Promise.resolve(true); }
	public destroy(): Promise<boolean> { this.destroyed = true; return Promise.resolve(true); }
}

const apps: ReturnType<typeof buildApp>[] = [];
const buildCatchApp = (repository = new FakeCatchRepository()) => {
	const app = buildApp({
		catch: { repository, tokenPepper: pepper, provisioningEnabled: true, provisioningSecret },
	});
	apps.push(app);
	return { app, repository };
};
const buildProxiedCatchApp = (trustedProxy: string, repository = new FakeCatchRepository()) => {
	const app = buildApp({
		trustedProxy,
		catch: { repository, tokenPepper: pepper, provisioningEnabled: true, provisioningSecret },
	});
	apps.push(app);
	return { app, repository };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function expectProvisionResponse(value: unknown): asserts value is { publicId: string; ownerToken: string; ingestToken: string } {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	const record = value as Record<string, unknown>;
	expect(typeof record.publicId).toBe("string");
	expect(typeof record.ownerToken).toBe("string");
	expect(typeof record.ingestToken).toBe("string");
}

afterEach(async () => {
	await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("CATCH HTTP API", () => {
	it("does not register internal provisioning by default", async () => {
		const app = buildApp();
		apps.push(app);
		expect((await app.inject({ method: "POST", url: "/internal/catch/provision" })).statusCode).toBe(404);
	});

	it("provisions every listed plan and returns distinct clear tokens once", async () => {
		const { app, repository } = buildCatchApp();
		const long = await app.inject({ method: "POST", url: "/internal/catch/provision", headers: bearer(provisioningSecret), payload: { planId: "long" } });
		expect(long.statusCode).toBe(201);

		const response = await app.inject({ method: "POST", url: "/internal/catch/provision", headers: bearer(provisioningSecret), payload: { planId: "spark" } });
		expect(response.statusCode).toBe(201);
		expect(response.headers["cache-control"]).toBe("no-store");
		const body: unknown = response.json();
		expectProvisionResponse(body);
		expect(body.publicId).toMatch(/^catch_[A-Za-z0-9_-]+$/);
		expect(body.ownerToken).toMatch(/^catch_own_/);
		expect(body.ingestToken).toMatch(/^catch_ing_/);
		expect(body.ownerToken).not.toBe(body.ingestToken);
		expect(repository.provisions).toHaveLength(2);
		expect(repository.provisions.map(([input]) => input.planId)).toEqual(["long", "spark"]);
		expect(repository.provisions[1]?.[0].ownerTokenHash).not.toBe(body.ownerToken);
	});

	it("accepts an authorized raw event as fixed empty 204 and filters headers", async () => {
		const { app, repository } = buildCatchApp();
		const response = await app.inject({
			method: "POST", url: "/c/catch_test-public-id", payload: "hello",
			headers: { ...bearer(ingestToken), "content-type": "text/plain", "user-agent": "test", cookie: "secret", "x-forwarded-for": "private", "x-request-id": "request-1" },
		});
		expect(response.statusCode).toBe(204);
		expect(response.body).toBe("");
		expect(repository.accepted[0]?.[0]).toMatchObject({ body: Buffer.from("hello"), headers: { "content-type": "text/plain", "user-agent": "test", "x-request-id": "request-1" } });
	});

	it("keeps ingest authenticated by default, can enable public ingest, and records webhook methods", async () => {
		const { app, repository } = buildCatchApp();
		expect((await app.inject({ method: "POST", url: "/c/catch_test-public-id", headers: { "content-type": "text/plain" }, payload: "denied" })).statusCode).toBe(401);
		const enabled = await app.inject({ method: "PATCH", url: "/api/catch/catch_test-public-id/settings", headers: bearer(ownerToken), payload: { ingestAuthRequired: false } });
		expect(enabled.statusCode).toBe(200);
		expect(enabled.json()).toMatchObject({ ingestAuthRequired: false });

		for (const method of ["POST", "PUT", "PATCH", "DELETE", "GET", "HEAD", "OPTIONS"] as const) {
			const response = await app.inject(method === "GET" || method === "HEAD" || method === "OPTIONS"
				? { method, url: "/c/catch_test-public-id?canary=1", headers: { "content-type": "text/plain" } }
				: { method, url: "/c/catch_test-public-id?canary=1", headers: { "content-type": "text/plain" }, payload: method });
			expect(response.statusCode).toBe(204);
		}
		expect(repository.accepted.map(([event]) => event.method)).toEqual(["POST", "PUT", "PATCH", "DELETE", "GET", "HEAD", "OPTIONS"]);
		expect(repository.accepted.every(([event]) => event.authenticated === false)).toBe(true);
	});

	it("marks token-backed events authenticated when public ingest is enabled", async () => {
		const { app, repository } = buildCatchApp();
		repository.ingestAuthRequired = false;
		const response = await app.inject({ method: "PUT", url: "/c/catch_test-public-id", headers: { ...bearer(ingestToken), "content-type": "application/json" }, payload: { ok: true } });
		expect(response.statusCode).toBe(204);
		expect(repository.accepted[0]?.[0]).toMatchObject({ method: "PUT", authenticated: true });
	});

	it("accepts a Spark payload above the former 16 KiB ceiling", async () => {
		const { app, repository } = buildCatchApp();
		const payload = "x".repeat(64 * 1024);
		const response = await app.inject({ method: "POST", url: "/c/catch_test-public-id", headers: { ...bearer(ingestToken), "content-type": "text/plain" }, payload });
		expect(response.statusCode).toBe(204);
		expect(repository.accepted[0]?.[0].body.byteLength).toBe(64 * 1024);
	});

	it("rejects incorrect role tokens, unsupported MIME, encoded and oversized ingestion", async () => {
		const { app, repository } = buildCatchApp();
		for (const request of [
			{ headers: { ...bearer(ownerToken), "content-type": "text/plain" }, payload: "x" },
			{ headers: { ...bearer(ingestToken), "content-type": "image/png" }, payload: "x" },
			{ headers: { ...bearer(ingestToken), "content-type": "text/plain", "content-encoding": "gzip" }, payload: "x" },
			{ headers: { ...bearer(ingestToken), "content-type": "text/plain" }, payload: "x".repeat(1024 * 1024 + 1) },
		]) {
			const response = await app.inject({ method: "POST", url: "/c/catch_test-public-id", ...request });
			expect(response.statusCode).toBeGreaterThanOrEqual(400);
		}
		expect(repository.accepted).toHaveLength(0);
	});

	it("rate-limits repeated ingestion attempts before unbounded database work", async () => {
		const { app } = buildCatchApp();
		let throttled = false;
		for (let attempt = 0; attempt < 70; attempt += 1) {
			const response = await app.inject({
				method: "POST",
				url: "/c/catch_test-public-id",
				headers: { ...bearer("catch_ing_wrong-token"), "content-type": "text/plain" },
				payload: "x",
			});
			if (response.statusCode === 429) {
				throttled = true;
				break;
			}
		}
		expect(throttled).toBe(true);
	});

	it("ignores spoofed forwarding headers from untrusted direct clients", async () => {
		const { app } = buildCatchApp();
		let finalStatus = 0;
		for (let attempt = 0; attempt < 61; attempt += 1) {
			const response = await app.inject({
				method: "POST",
				url: "/c/catch_test-public-id",
				headers: {
					...bearer("catch_ing_wrong-token"),
					"content-type": "text/plain",
					"x-forwarded-for": `198.51.100.${attempt + 1}`,
				},
				payload: "x",
			});
			finalStatus = response.statusCode;
		}
		expect(finalStatus).toBe(429);
	});

	it("uses forwarding headers only when the direct proxy address is trusted", async () => {
		const { app } = buildProxiedCatchApp("127.0.0.1");
		for (let attempt = 0; attempt < 60; attempt += 1) {
			const response = await app.inject({
				method: "POST",
				url: "/c/catch_test-public-id",
				headers: {
					...bearer("catch_ing_wrong-token"),
					"content-type": "text/plain",
					"x-forwarded-for": "198.51.100.10",
				},
				payload: "x",
			});
			expect(response.statusCode).toBe(401);
		}
		const throttled = await app.inject({
			method: "POST",
			url: "/c/catch_test-public-id",
			headers: {
				...bearer("catch_ing_wrong-token"),
				"content-type": "text/plain",
				"x-forwarded-for": "198.51.100.10",
			},
			payload: "x",
		});
		expect(throttled.statusCode).toBe(429);

		const differentClient = await app.inject({
			method: "POST",
			url: "/c/catch_test-public-id",
			headers: {
				...bearer("catch_ing_wrong-token"),
				"content-type": "text/plain",
				"x-forwarded-for": "198.51.100.11",
			},
			payload: "x",
		});
		expect(differentClient.statusCode).toBe(401);
	});

	it("ignores forwarding headers when the direct peer does not match the configured proxy", async () => {
		const { app } = buildProxiedCatchApp("192.0.2.1");
		let finalStatus = 0;
		for (let attempt = 0; attempt < 61; attempt += 1) {
			const response = await app.inject({
				method: "POST",
				url: "/c/catch_test-public-id",
				headers: {
					...bearer("catch_ing_wrong-token"),
					"content-type": "text/plain",
					"x-forwarded-for": `198.51.100.${attempt + 1}`,
				},
				payload: "x",
			});
			finalStatus = response.statusCode;
		}
		expect(finalStatus).toBe(429);
	});

	it("rate-limits owner authentication before repeated database lookups", async () => {
		const { app, repository } = buildCatchApp();
		let finalStatus = 0;
		for (let attempt = 0; attempt < 31; attempt += 1) {
			const response = await app.inject({ method: "GET", url: `/api/catch/missing-${attempt}`, headers: bearer("catch_own_wrong-token") });
			finalStatus = response.statusCode;
		}
		expect(finalStatus).toBe(429);
		expect(repository.credentialLookups).toBe(30);
	});

	it("protects admin data, avoids token leaks, and irreversibly destroys resources", async () => {
		const { app, repository } = buildCatchApp();
		const denied = await app.inject({ method: "GET", url: "/api/catch/catch_test-public-id", headers: bearer(ingestToken) });
		expect(denied.statusCode).toBe(401);
		const status = await app.inject({ method: "GET", url: "/api/catch/catch_test-public-id", headers: bearer(ownerToken) });
		expect(status.statusCode).toBe(200);
		expect(status.headers["cache-control"]).toBe("no-store");
		expect(status.body).not.toContain("Token");
		const events = await app.inject({ method: "GET", url: "/api/catch/catch_test-public-id/events?limit=100", headers: bearer(ownerToken) });
		expect(events.statusCode).toBe(200);
		const deleted = await app.inject({ method: "DELETE", url: "/api/catch/catch_test-public-id/events/event-1", headers: bearer(ownerToken) });
		expect(deleted.statusCode).toBe(204);
		const destroyed = await app.inject({ method: "DELETE", url: "/api/catch/catch_test-public-id", headers: bearer(ownerToken) });
		expect(destroyed.statusCode).toBe(204);
		expect(repository.destroyed).toBe(true);
	});

	it("passes bounded event filters and cursors to the repository", async () => {
		const { app, repository } = buildCatchApp();
		const listEvents = vi.spyOn(repository, "listEvents");
		const response = await app.inject({ method: "GET", url: "/api/catch/catch_test-public-id/events?limit=20&cursor=40&access=public&method=PUT&contentType=application%2Fjson&q=needle", headers: bearer(ownerToken) });
		expect(response.statusCode).toBe(200);
		expect(listEvents).toHaveBeenCalledWith("catch_test-public-id", { limit: 20, cursor: 40, access: "public", method: "PUT", contentType: "application/json", query: "needle" });
	});
});
