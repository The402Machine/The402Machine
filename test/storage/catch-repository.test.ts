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
	const migration = await readFile(new URL("../../migrations/0001_catch.sql", import.meta.url), "utf8");
	await sql.unsafe(migration).simple();
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
	});
});
