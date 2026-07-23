import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const image = "postgres:17-alpine";
const container = `the402machine-test-${randomUUID()}`;
const password = "catch-test-password";
let databaseUrl = "";
let sql: ReturnType<typeof postgres>;

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
	docker(
		"run",
		"--detach",
		"--rm",
		"--name",
		container,
		"--publish",
		"127.0.0.1::5432",
		"--env",
		`POSTGRES_PASSWORD=${password}`,
		"--env",
		"POSTGRES_DB=the402machine_test",
		image,
	);

	const port = docker("port", container, "5432/tcp").split(":").at(-1);
	if (port === undefined) {
		throw new Error("Could not determine PostgreSQL test port");
	}

	databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/the402machine_test`;
	await waitForPostgres();
	sql = postgres(databaseUrl, { max: 4 });

	for (const file of ["0001_catch.sql", "0004_catch_storage_hardening.sql"]) {
		const migration = await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
		await sql.unsafe(migration).simple();
	}
}, 60_000);

afterAll(async () => {
	await sql?.end();
	try {
		docker("rm", "--force", container);
	} catch {
		// The container may already have exited and removed itself.
	}
});

describe("CATCH migration", () => {
	it("creates the resource and event tables with the migration marker", async () => {
		const [row] = await sql<{ resource: string | null; event: string | null; version: string | null }[]>`
			select
				to_regclass('public.catch_resources')::text as resource,
				to_regclass('public.catch_events')::text as event,
				(select version from schema_migrations where version = '0001_catch') as version
		`;

		expect(row).toEqual({
			resource: "catch_resources",
			event: "catch_events",
			version: "0001_catch",
		});
	});

	it("rejects counters beyond the purchased quotas", async () => {
		await expect(sql`
			insert into catch_resources (
				public_id, plan_id, owner_token_hash, ingest_token_hash,
				request_limit, storage_limit_bytes, max_bytes_per_request,
				accepted_request_count, stored_bytes, expires_at
			) values (
				${`catch_${"a".repeat(22)}`}, 'spark', 'owner', 'ingest',
				402, ${2 * 1024 * 1024}, ${16 * 1024},
				403, 0, clock_timestamp() + interval '1 hour'
			)
		`).rejects.toMatchObject({ code: "23514" });
	});

	it("requires live and readable resources to retain both credentials", async () => {
		for (const status of ["active", "exhausted", "suspended"]) {
			await expect(sql`
				insert into catch_resources (
					public_id, plan_id, status, owner_token_hash, ingest_token_hash,
					request_limit, storage_limit_bytes, max_bytes_per_request, expires_at
				) values (
					${`catch_${status}_${randomUUID().replaceAll("-", "")}`}, 'spark', ${status}::catch_resource_status, null, null,
					402, ${2 * 1024 * 1024}, ${16 * 1024}, clock_timestamp() + interval '1 hour'
				)
			`).rejects.toMatchObject({ code: "23514" });
		}
	});

	it("requires terminal resources to have both credentials erased", async () => {
		for (const status of ["expired", "manually_destroyed", "deleted"]) {
			await expect(sql`
				insert into catch_resources (
					public_id, plan_id, status, owner_token_hash, ingest_token_hash,
					request_limit, storage_limit_bytes, max_bytes_per_request, expires_at
				) values (
					${`catch_${status}_${randomUUID().replaceAll("-", "")}`}, 'spark', ${status}::catch_resource_status, 'owner', 'ingest',
					402, ${2 * 1024 * 1024}, ${16 * 1024}, clock_timestamp() + interval '1 hour'
				)
			`).rejects.toMatchObject({ code: "23514" });
		}
	});
});
