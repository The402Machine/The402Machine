import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatchRepository } from "../../src/storage/catch-repository.js";

const image = "postgres:17-alpine";
const container = `the402machine-expiry-test-${randomUUID()}`;
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
	sql = postgres(databaseUrl, { max: 4 });
	const migration = await readFile(new URL("../../migrations/0001_catch.sql", import.meta.url), "utf8");
	await sql.unsafe(migration).simple();
	repository = new CatchRepository(sql);
}, 60_000);

afterAll(async () => {
	await sql?.end();
	try { docker("rm", "--force", container); } catch { /* container already removed */ }
});

const provisionExpiredResource = async (): Promise<string> => {
	const publicId = `catch_${randomUUID().replaceAll("-", "")}`;
	const [row] = await sql<{ id: string }[]>`
		insert into catch_resources (
			public_id, plan_id, owner_token_hash, ingest_token_hash,
			request_limit, storage_limit_bytes, max_bytes_per_request, created_at, expires_at
		) values (
			${publicId}, 'spark', ${"a".repeat(64)}, ${"b".repeat(64)},
			402, ${2 * 1024 * 1024}, ${16 * 1024},
			clock_timestamp() - interval '2 seconds', clock_timestamp() - interval '1 second'
		) returning id
	`;
	if (row === undefined) throw new Error("Could not seed expired resource");
	await sql`
		insert into catch_events (resource_id, sequence_number, content_type, headers, body)
		values (${row.id}, 1, 'text/plain', '{}'::jsonb, ${Buffer.from("expired secret")})
	`;
	await sql`update catch_resources set accepted_request_count = 1, stored_bytes = ${Buffer.byteLength("expired secret")} where id = ${row.id}`;
	return publicId;
};

describe("CATCH expiry lifecycle", () => {
	it("purges expired bodies, counters, and credentials in bounded batches", async () => {
		const publicId = await provisionExpiredResource();

		const expired = await repository.expireDueResources(10);

		expect(expired).toBe(1);
		const [row] = await sql<{
			status: string;
			owner_token_hash: string | null;
			ingest_token_hash: string | null;
			stored_bytes: string;
			event_count: string;
		}[]>`
			select r.status, r.owner_token_hash, r.ingest_token_hash, r.stored_bytes,
				(select count(*) from catch_events e where e.resource_id = r.id)::text as event_count
			from catch_resources r where r.public_id = ${publicId}
		`;
		expect(row).toMatchObject({
			status: "expired",
			owner_token_hash: null,
			ingest_token_hash: null,
			stored_bytes: "0",
			event_count: "0",
		});
	});

	it("does not expire more resources than the requested batch size", async () => {
		await provisionExpiredResource();
		await provisionExpiredResource();

		expect(await repository.expireDueResources(1)).toBe(1);
		const [remaining] = await sql<{ count: string }[]>`
			select count(*)::text as count from catch_resources
			where status in ('active', 'exhausted', 'suspended') and clock_timestamp() >= expires_at
		`;
		expect(Number(remaining?.count)).toBeGreaterThanOrEqual(1);
	});
});
