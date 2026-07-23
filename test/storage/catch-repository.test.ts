import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { calculatePlanExpiry, CATCH_PLANS } from "../../src/domain/catch-plans.js";
import { CatchRepository } from "../../src/storage/catch-repository.js";

const image = "postgres:17-alpine";
const container = `the402machine-repo-test-${randomUUID()}`;
const password = "catch-test-password";
let databaseUrl = "";
let sql: ReturnType<typeof postgres>;
let repository: CatchRepository;

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" }).trim();

const waitForPostgres = async (): Promise<void> => {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const probe = postgres(databaseUrl, { max: 1, connect_timeout: 1 });
			await probe`select 1`;
			await probe.end();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error("PostgreSQL test container did not become ready");
};

beforeAll(async () => {
	docker("pull", image);
	docker("run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=the402machine_test", image);
	const port = docker("port", container, "5432/tcp").split(":").at(-1);
	if (port === undefined) throw new Error("Could not determine PostgreSQL test port");
	databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/the402machine_test`;
	await waitForPostgres();
	sql = postgres(databaseUrl, { max: 12 });
	for (const file of ["0001_catch.sql", "0004_catch_storage_hardening.sql", "0005_catch_storage_reconcile.sql"]) {
		const migration = await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
		await sql.unsafe(migration).simple();
	}
	repository = new CatchRepository(sql);
}, 60_000);

afterAll(async () => {
	await sql?.end();
	try { docker("rm", "--force", container); } catch { /* container already removed */ }
});

const provisionSpark = async (overrides: { requestLimit?: number; storageLimitBytes?: number; expiresAt?: Date } = {}) => {
	const plan = CATCH_PLANS.spark;
	return repository.provision({
		publicId: `catch_${randomUUID().replaceAll("-", "")}`,
		planId: "spark",
		ownerTokenHash: randomUUID().replaceAll("-", ""),
		ingestTokenHash: randomUUID().replaceAll("-", ""),
		requestLimit: overrides.requestLimit ?? plan.requestLimit,
		storageLimitBytes: overrides.storageLimitBytes ?? plan.storageLimitBytes,
		maxBytesPerRequest: plan.maxBytesPerRequest,
		expiresAt: overrides.expiresAt ?? calculatePlanExpiry("spark", new Date()),
	});
};

const rawResource = async (publicId: string) => {
	const [row] = await sql<{ status: string; owner_token_hash: string | null; ingest_token_hash: string | null; stored_bytes: string }[]>`
		select status, owner_token_hash, ingest_token_hash, stored_bytes
		from catch_resources
		where public_id = ${publicId}
	`;
	return row;
};

const eventCount = async (resourceId: string): Promise<number> => {
	const [row] = await sql<{ count: number }[]>`select count(*)::int as count from catch_events where resource_id = ${resourceId}`;
	return row?.count ?? 0;
};

describe("CatchRepository", () => {
	it("provisions a resource and reads its private status", async () => {
		const resource = await provisionSpark();
		const loaded = await repository.getResource(resource.publicId);

		expect(loaded).toMatchObject({
			publicId: resource.publicId,
			planId: "spark",
			status: "active",
			acceptedRequestCount: 0,
			storedBytes: 0,
		});
	});

	it("serializes concurrent accepts and never exceeds the request quota", async () => {
		const resource = await provisionSpark({ requestLimit: 2 });
		const results = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.acceptEvent({
			publicId: resource.publicId,
			contentType: "application/json",
			headers: { "x-request-id": String(index) },
			body: Buffer.from(`{"index":${index}}`),
		})));

		expect(results.filter((result) => result.accepted)).toHaveLength(2);
		expect(results.filter((result) => !result.accepted && result.reason === "exhausted")).toHaveLength(6);
		const loaded = await repository.getResource(resource.publicId);
		expect(loaded).toMatchObject({ status: "exhausted", acceptedRequestCount: 2 });
	});

	it("does not store an event that would exceed the byte quota", async () => {
		const resource = await provisionSpark({ storageLimitBytes: 5 });
		const result = await repository.acceptEvent({
			publicId: resource.publicId,
			contentType: "text/plain",
			headers: {},
			body: Buffer.from("123456"),
		});

		expect(result).toEqual({ accepted: false, reason: "exhausted" });
		const events = await repository.listEvents(resource.publicId, 50);
		expect(events).toEqual([]);
	});

	it("serializes concurrent accepts and never exceeds the byte quota", async () => {
		const resource = await provisionSpark({ requestLimit: 10, storageLimitBytes: 14 });
		const results = await Promise.all(Array.from({ length: 6 }, () => repository.acceptEvent({
			publicId: resource.publicId,
			contentType: "text/plain",
			headers: {},
			body: Buffer.from("123"),
		})));

		expect(results.filter((result) => result.accepted)).toHaveLength(2);
		expect(results.filter((result) => !result.accepted && "reason" in result && result.reason === "exhausted")).toHaveLength(4);
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "exhausted", stored_bytes: "10" });
		expect(await eventCount(resource.id)).toBe(2);
	});

	it("accepts exactly at quota and leaves a stable exhausted resource", async () => {
		const resource = await provisionSpark({ requestLimit: 2, storageLimitBytes: 10 });
		const first = await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("123") });
		const second = await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("456") });
		const third = await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("7") });

		expect(first.accepted).toBe(true);
		expect(second.accepted).toBe(true);
		expect(third).toEqual({ accepted: false, reason: "exhausted" });
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "exhausted", stored_bytes: "10" });
		expect(await eventCount(resource.id)).toBe(2);
	});

	it("rejects oversized request bodies without storing them", async () => {
		const resource = await repository.provision({
			publicId: `catch_${randomUUID().replaceAll("-", "")}`,
			planId: "spark",
			ownerTokenHash: randomUUID().replaceAll("-", ""),
			ingestTokenHash: randomUUID().replaceAll("-", ""),
			requestLimit: 5,
			storageLimitBytes: 100,
			maxBytesPerRequest: 4,
			expiresAt: calculatePlanExpiry("spark", new Date()),
		});

		expect(await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("12345") })).toEqual({ accepted: false, reason: "body_too_large" });
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "active", stored_bytes: "0" });
		expect(await eventCount(resource.id)).toBe(0);
	});

	it("counts persisted headers against storage quota", async () => {
		const resource = await provisionSpark({ requestLimit: 5, storageLimitBytes: 5 });
		const result = await repository.acceptEvent({
			publicId: resource.publicId,
			contentType: "text/plain",
			headers: { "x-request-id": "abcd" },
			body: Buffer.from("x"),
		});

		expect(result).toEqual({ accepted: false, reason: "exhausted" });
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "exhausted", stored_bytes: "0" });
		expect(await eventCount(resource.id)).toBe(0);
	});

	it("rejects non-allowlisted headers at the repository boundary", async () => {
		const resource = await provisionSpark();
		await expect(repository.acceptEvent({
			publicId: resource.publicId,
			contentType: "text/plain",
			headers: { cookie: "secret" },
			body: Buffer.from("x"),
		})).rejects.toThrow("CATCH event headers are invalid");
		expect(await eventCount(resource.id)).toBe(0);
	});

	it("expires and erases credentials before the worker runs", async () => {
		const resource = await provisionSpark({ expiresAt: new Date(Date.now() + 150) });
		await new Promise((resolve) => setTimeout(resolve, 200));

		const result = await repository.acceptEvent({
			publicId: resource.publicId,
			contentType: "text/plain",
			headers: {},
			body: Buffer.from("late"),
		});

		expect(result).toEqual({ accepted: false, reason: "expired" });
		const loaded = await repository.getResource(resource.publicId);
		expect(loaded?.status).toBe("expired");
	});

	it("does not return credentials after database-time expiry even before cleanup", async () => {
		const resource = await provisionSpark();
		await sql`
			update catch_resources
			set created_at = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second'
			where id = ${resource.id}
		`;

		expect(await repository.getCredentialHashes(resource.publicId)).toBeNull();
	});

	it("expires and purges an overdue resource during owner credential lookup", async () => {
		const resource = await provisionSpark();
		await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("stored") });
		await sql`update catch_resources set created_at = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second' where id = ${resource.id}`;

		expect(await repository.getCredentialHashes(resource.publicId)).toBeNull();
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "expired", owner_token_hash: null, ingest_token_hash: null, stored_bytes: "0" });
		expect(await eventCount(resource.id)).toBe(0);
	});

	it("expires and purges an overdue resource during private listing", async () => {
		const resource = await provisionSpark();
		await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("stored") });
		await sql`update catch_resources set created_at = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second' where id = ${resource.id}`;

		expect(await repository.listEvents(resource.publicId, 50)).toEqual([]);
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "expired", owner_token_hash: null, ingest_token_hash: null, stored_bytes: "0" });
		expect(await eventCount(resource.id)).toBe(0);
	});

	it("uses the database clock for expiry rather than the application clock", async () => {
		const resource = await provisionSpark();
		await sql`
			update catch_resources
			set created_at = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second'
			where id = ${resource.id}
		`;
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2000-01-01T00:00:00.000Z").getTime());

		try {
			const result = await repository.acceptEvent({
				publicId: resource.publicId,
				contentType: "text/plain",
				headers: {},
				body: Buffer.from("late"),
			});

			expect(result).toEqual({ accepted: false, reason: "expired" });
		} finally {
			dateNowSpy.mockRestore();
		}
	});

	it("lists bounded events, deletes one, and destroys the resource irreversibly", async () => {
		const resource = await provisionSpark();
		await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("one") });
		await repository.acceptEvent({ publicId: resource.publicId, contentType: "text/plain", headers: {}, body: Buffer.from("two") });

		const events = await repository.listEvents(resource.publicId, 1);
		expect(events).toHaveLength(1);
		expect(events[0]?.body.toString()).toBe("two");
		await repository.deleteEvent(resource.publicId, events[0]!.id);
		expect(await repository.listEvents(resource.publicId, 50)).toHaveLength(1);

		await repository.destroy(resource.publicId);
		expect(await repository.listEvents(resource.publicId, 50)).toEqual([]);
		expect((await repository.getResource(resource.publicId))?.status).toBe("manually_destroyed");
		expect(await rawResource(resource.publicId)).toMatchObject({ status: "manually_destroyed", owner_token_hash: null, ingest_token_hash: null, stored_bytes: "0" });
		expect(await eventCount(resource.id)).toBe(0);
	});

	it("uses legal terminal transitions when destroying inactive resources", async () => {
		const exhausted = await provisionSpark({ requestLimit: 1 });
		await repository.acceptEvent({
			publicId: exhausted.publicId,
			contentType: "text/plain",
			headers: {},
			body: Buffer.from("one"),
		});
		expect((await repository.getResource(exhausted.publicId))?.status).toBe("exhausted");
		expect(await repository.destroy(exhausted.publicId)).toBe(true);
		expect((await repository.getResource(exhausted.publicId))?.status).toBe("deleted");

		const suspended = await provisionSpark();
		await sql`
			update catch_resources
			set status = 'suspended', suspended_at = clock_timestamp()
			where id = ${suspended.id}
		`;
		expect(await repository.destroy(suspended.publicId)).toBe(true);
		expect((await repository.getResource(suspended.publicId))?.status).toBe("deleted");
	});
});
