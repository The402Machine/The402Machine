import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { generatePulseToken, hashPulseToken } from "../../src/security/pulse-tokens.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => app.close())); });

function repositoryFixture() {
	const resource = {
		id: "resource-pulse-1", publicId: "pulse_abcdefghijklmnopqrstuv", planId: "spark" as const, status: "active" as "active" | "exhausted" | "expired" | "manually_destroyed",
		ownerTokenHash: hashPulseToken("owner", "pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "pepper"),
		pingTokenHash: hashPulseToken("ping", "pulse_ping_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "pepper"),
		heartbeatLimit: 1_202, heartbeatCount: 0, expectedIntervalSeconds: 300, graceSeconds: 600,
		name: "Backup heartbeat", description: "Nightly backup worker", publicStatusEnabled: true,
		lastPingAt: null, createdAt: new Date("2026-07-24T10:00:00.000Z"), expiresAt: new Date("2026-07-28T12:00:00.000Z"),
	};
	return {
		resource,
		getResource: () => Promise.resolve(resource),
		getCredentialHashes: () => Promise.resolve({ ownerTokenHash: resource.ownerTokenHash, pingTokenHash: resource.pingTokenHash }),
		acceptHeartbeat: () => Promise.resolve({ accepted: true as const, heartbeatCount: 1, lastPingAt: new Date("2026-07-24T10:05:00.000Z"), exhausted: false }),
		updateSettings: () => Promise.resolve(resource),
		destroy: () => Promise.resolve(true),
	};
}

describe("PULSE API", () => {
	it("accepts tokenized heartbeat capabilities and never stores request bodies", async () => {
		const repository = repositoryFixture();
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "POST", url: `/p/${repository.resource.publicId}`, headers: { authorization: "Bearer pulse_ping_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "text/plain" }, payload: "ignored by design" });
		expect(response.statusCode).toBe(204);
	});

	it("returns a private owner status and supports API settings", async () => {
		const repository = repositoryFixture();
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const headers = { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" };
		const status = await app.inject({ method: "GET", url: `/api/pulse/${repository.resource.publicId}`, headers });
		expect(status.statusCode).toBe(200);
		expect(status.headers["cache-control"]).toBe("no-store");
		expect(status.json()).toMatchObject({ publicId: repository.resource.publicId, state: "waiting", heartbeatLimit: 1_202, heartbeatCount: 0, expectedIntervalSeconds: 300, graceSeconds: 600 });
		const update = await app.inject({ method: "PATCH", url: `/api/pulse/${repository.resource.publicId}`, headers: { ...headers, "content-type": "application/json" }, payload: { name: "Production backup", description: "Runs every five minutes", expectedIntervalSeconds: 300, graceSeconds: 900, publicStatusEnabled: false } });
		expect(update.statusCode).toBe(200);
	});

	it("exposes only bounded public status data when enabled", async () => {
		const repository = repositoryFixture();
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "GET", url: `/api/pulse/${repository.resource.publicId}/public` });
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toContain("max-age");
		expect(response.json()).toEqual({ name: "Backup heartbeat", description: "Nightly backup worker", state: "waiting", lastPingAt: null, expectedIntervalSeconds: 300, graceSeconds: 600, expiresAt: "2026-07-28T12:00:00.000Z" });
		expect(response.body).not.toContain("Token");
		expect(response.body).not.toContain("heartbeatLimit");
	});

	it("hides disabled public pages and supports explicit destruction", async () => {
		const repository = repositoryFixture();
		repository.resource.publicStatusEnabled = false;
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		expect((await app.inject({ method: "GET", url: `/api/pulse/${repository.resource.publicId}/public` })).statusCode).toBe(404);
		const destroyed = await app.inject({ method: "DELETE", url: `/api/pulse/${repository.resource.publicId}`, headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" } });
		expect(destroyed.statusCode).toBe(204);
	});

	it("hides public status after the monitor expires", async () => {
		const repository = repositoryFixture();
		repository.resource.status = "expired";
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "GET", url: `/api/pulse/${repository.resource.publicId}/public` });
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "not found" });
	});

	it("generates role-specific high-entropy capabilities", () => {
		expect(generatePulseToken("owner")).toMatch(/^pulse_own_[A-Za-z0-9_-]{43}$/u);
		expect(generatePulseToken("ping")).toMatch(/^pulse_ping_[A-Za-z0-9_-]{43}$/u);
	});
});
