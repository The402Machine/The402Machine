import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { PulseSettings } from "../../src/pulse/pulse-repository.js";
import { generatePulseToken, hashPulseToken } from "../../src/security/pulse-tokens.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => app.close())); });

function repositoryFixture() {
	const now = Date.now();
	const resource = {
		id: "resource-pulse-1", publicId: "pulse_abcdefghijklmnopqrstuv", publicStatusId: "pulse_status_zyxwvutsrqponmlkjihgfe", planId: "spark" as const, status: "active" as "active" | "exhausted" | "expired" | "manually_destroyed",
		ownerTokenHash: hashPulseToken("owner", "pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "pepper"),
		pingTokenHash: hashPulseToken("ping", "pulse_ping_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "pepper"),
		heartbeatLimit: 1_202, heartbeatCount: 0, expectedIntervalSeconds: 300, graceSeconds: 600,
		name: "Backup heartbeat", description: "Nightly backup worker", publicStatusEnabled: true,
		lastPingAt: null, createdAt: new Date(now - 60_000), expiresAt: new Date(now + 4 * 24 * 60 * 60 * 1_000),
	};
	return {
		resource,
		getResource: () => Promise.resolve(resource),
		getPublicResource: (publicStatusId: string) => Promise.resolve(publicStatusId === resource.publicStatusId || publicStatusId === resource.publicId ? resource : null),
		getCredentialHashes: () => Promise.resolve({ ownerTokenHash: resource.ownerTokenHash, pingTokenHash: resource.pingTokenHash }),
		acceptHeartbeat: () => Promise.resolve({ accepted: true as const, heartbeatCount: 1, lastPingAt: new Date(now), exhausted: false }),
		updateSettings: function (this: void, ...args: [string, PulseSettings]) { void args; return Promise.resolve(resource); },
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
		expect(status.json()).toMatchObject({ publicId: repository.resource.publicId, publicStatusId: repository.resource.publicStatusId, state: "waiting", heartbeatLimit: 1_202, heartbeatCount: 0, heartbeatsRemaining: 1_202, expectedIntervalSeconds: 300, graceSeconds: 600 });
		const update = await app.inject({ method: "PATCH", url: `/api/pulse/${repository.resource.publicId}`, headers: { ...headers, "content-type": "application/json" }, payload: { name: "Production backup", description: "Runs every five minutes", expectedIntervalSeconds: 300, graceSeconds: 900, publicStatusEnabled: false } });
		expect(update.statusCode).toBe(200);
	});

	it("enables the public page with the default Spark schedule and an empty description", async () => {
		const repository = repositoryFixture();
		repository.resource.publicStatusEnabled = false;
		let receivedSettings: unknown = null;
		repository.updateSettings = (_publicId: string, settings: PulseSettings) => {
			receivedSettings = settings;
			Object.assign(repository.resource, settings);
			return Promise.resolve(repository.resource);
		};
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({
			method: "PATCH",
			url: `/api/pulse/${repository.resource.publicId}`,
			headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "application/json" },
			payload: { name: "Untitled monitor", description: "", expectedIntervalSeconds: 300, graceSeconds: 600, publicStatusEnabled: true },
		});
		expect(response.statusCode).toBe(200);
		expect(receivedSettings).toEqual({ name: "Untitled monitor", description: "", expectedIntervalSeconds: 300, graceSeconds: 600, publicStatusEnabled: true });
		expect(response.json()).toMatchObject({ publicStatusEnabled: true, expectedIntervalSeconds: 300, graceSeconds: 600 });
	});

	it("parses owner JSON settings even when the CATCH raw JSON parser is registered", async () => {
		const repository = repositoryFixture();
		repository.resource.publicStatusEnabled = false;
		repository.updateSettings = (_publicId: string, settings: PulseSettings) => {
			Object.assign(repository.resource, settings);
			return Promise.resolve(repository.resource);
		};
		const app = buildApp({
			pulse: { repository, tokenPepper: "pepper" },
			catch: {
				repository: {
					provision: () => Promise.reject(new Error("unused")), getResource: () => Promise.resolve(null), getCredentialHashes: () => Promise.resolve(null),
					acceptEvent: () => Promise.reject(new Error("unused")), setEventIpLocation: () => Promise.resolve(false), listEvents: () => Promise.resolve({ events: [], nextCursor: null }),
					deleteEvent: () => Promise.resolve(false), destroy: () => Promise.resolve(false),
				},
				tokenPepper: "pepper",
			},
		});
		apps.push(app);
		const response = await app.inject({
			method: "PATCH",
			url: `/api/pulse/${repository.resource.publicId}`,
			headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "application/json" },
			payload: { publicStatusEnabled: true },
		});
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({ publicStatusEnabled: true });
	});

	it("rejects unknown settings fields instead of silently accepting client mistakes", async () => {
		const repository = repositoryFixture();
		let updates = 0;
		repository.updateSettings = () => { updates += 1; return Promise.resolve(repository.resource); };
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({
			method: "PATCH",
			url: `/api/pulse/${repository.resource.publicId}`,
			headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "application/json" },
			payload: { publicStatusEnabled: true, publicStatusEnabledd: true },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid settings" });
		expect(updates).toBe(0);
	});

	it("validates trimmed name and description lengths before persisting settings", async () => {
		const repository = repositoryFixture();
		let updates = 0;
		repository.updateSettings = () => { updates += 1; return Promise.resolve(repository.resource); };
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const headers = { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "application/json" };
		const paddedName = await app.inject({ method: "PATCH", url: `/api/pulse/${repository.resource.publicId}`, headers, payload: { name: `${"a".repeat(80)} ` } });
		const paddedDescription = await app.inject({ method: "PATCH", url: `/api/pulse/${repository.resource.publicId}`, headers, payload: { description: ` ${"d".repeat(240)} ` } });
		expect(paddedName.statusCode).toBe(200);
		expect(paddedDescription.statusCode).toBe(200);
		expect(updates).toBe(2);
	});

	it("toggles public sharing without resubmitting unrelated monitor settings", async () => {
		const repository = repositoryFixture();
		repository.resource.publicStatusEnabled = false;
		let receivedSettings: PulseSettings | null = null;
		repository.updateSettings = (_publicId: string, settings: PulseSettings) => {
			receivedSettings = settings;
			Object.assign(repository.resource, settings);
			return Promise.resolve(repository.resource);
		};
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({
			method: "PATCH",
			url: `/api/pulse/${repository.resource.publicId}`,
			headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "application/json" },
			payload: { publicStatusEnabled: true },
		});
		expect(response.statusCode).toBe(200);
		expect(receivedSettings).toEqual({ name: "Backup heartbeat", description: "Nightly backup worker", expectedIntervalSeconds: 300, graceSeconds: 600, publicStatusEnabled: true });
	});

	it("exposes only bounded public status data when enabled", async () => {
		const repository = repositoryFixture();
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "GET", url: `/api/pulse/public/${repository.resource.publicStatusId}` });
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.json()).toEqual({ name: "Backup heartbeat", description: "Nightly backup worker", state: "waiting", lastPingAt: null });
		expect(response.body).not.toContain("Token");
		expect(response.body).not.toContain("heartbeatLimit");
		expect(response.body).not.toContain("expectedIntervalSeconds");
		expect(response.body).not.toContain("graceSeconds");
		expect(response.body).not.toContain("expiresAt");
		expect(response.body).not.toContain(repository.resource.publicId);
	});

	it("keeps already-shared legacy public links read-only during the identifier transition", async () => {
		const repository = repositoryFixture();
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "GET", url: `/api/pulse/public/${repository.resource.publicId}` });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ name: "Backup heartbeat", description: "Nightly backup worker", state: "waiting", lastPingAt: null });
		expect(response.json()).not.toHaveProperty("publicId");
	});

	it("hides disabled public pages and supports explicit destruction", async () => {
		const repository = repositoryFixture();
		repository.resource.publicStatusEnabled = false;
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		expect((await app.inject({ method: "GET", url: `/api/pulse/public/${repository.resource.publicStatusId}` })).statusCode).toBe(404);
		const destroyed = await app.inject({ method: "DELETE", url: `/api/pulse/${repository.resource.publicId}`, headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ" } });
		expect(destroyed.statusCode).toBe(204);
	});

	it("prevents stale shared status after the owner disables the public page", async () => {
		const repository = repositoryFixture();
		repository.updateSettings = (_publicId: string, settings: PulseSettings) => {
			Object.assign(repository.resource, settings);
			return Promise.resolve(repository.resource);
		};
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const publicUrl = `/api/pulse/public/${repository.resource.publicStatusId}`;
		const visible = await app.inject({ method: "GET", url: publicUrl });
		expect(visible.statusCode).toBe(200);
		expect(visible.headers["cache-control"]).toBe("no-store");
		const disabled = await app.inject({
			method: "PATCH",
			url: `/api/pulse/${repository.resource.publicId}`,
			headers: { authorization: "Bearer pulse_own_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "content-type": "application/json" },
			payload: { publicStatusEnabled: false },
		});
		expect(disabled.statusCode).toBe(200);
		const hidden = await app.inject({ method: "GET", url: publicUrl });
		expect(hidden.statusCode).toBe(404);
		expect(hidden.headers["cache-control"]).toBe("no-store");
	});

	it("hides public status after the monitor expires", async () => {
		const repository = repositoryFixture();
		repository.resource.status = "expired";
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "GET", url: `/api/pulse/public/${repository.resource.publicStatusId}` });
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "not found" });
	});

	it("hides public status as soon as expiresAt passes before the worker runs", async () => {
		const repository = repositoryFixture();
		repository.resource.expiresAt = new Date(Date.now() - 1_000);
		const app = buildApp({ pulse: { repository, tokenPepper: "pepper" } }); apps.push(app);
		const response = await app.inject({ method: "GET", url: `/api/pulse/public/${repository.resource.publicStatusId}` });
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "not found" });
	});

	it("generates role-specific high-entropy capabilities", () => {
		expect(generatePulseToken("owner")).toMatch(/^pulse_own_[A-Za-z0-9_-]{43}$/u);
		expect(generatePulseToken("ping")).toMatch(/^pulse_ping_[A-Za-z0-9_-]{43}$/u);
	});
});
