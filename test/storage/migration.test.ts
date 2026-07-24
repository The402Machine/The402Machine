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

	for (const file of ["0001_catch.sql", "0002_payments.sql", "0003_whisper.sql", "0004_catch_storage_hardening.sql", "0005_catch_storage_reconcile.sql", "0006_payment_pricing_v2.sql", "0007_whisper_payload_v2.sql", "0008_catch_flexible_ingest.sql", "0009_catch_ip_metadata.sql", "0010_whisper_multiread.sql"]) {
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

	it("accepts current prices while preserving already issued legacy orders", async () => {
		for (const [planId, amountSats] of [["spark", 4], ["spark", 42], ["standard", 42], ["standard", 402], ["long", 402], ["long", 4002]] as const) {
			await expect(sql`
				insert into payment_orders (idempotency_key, product, plan_id, amount_sats)
				values (${`pricing-${planId}-${amountSats}`}, 'catch', ${planId}::catch_plan_id, ${amountSats})
			`).resolves.toBeDefined();
		}

		await expect(sql`
			insert into payment_orders (idempotency_key, product, plan_id, amount_sats)
			values ('pricing-invalid', 'catch', 'spark', 402)
		`).rejects.toMatchObject({ code: "23514" });
	});

	it("accepts WHISPER ciphertext up to 4.02 MiB in orders and resources", async () => {
		const legacyLimits = await sql<{ table_name: string; definition: string }[]>`
			select conrelid::regclass::text as table_name, pg_get_constraintdef(oid) as definition
			from pg_constraint
			where conrelid in ('payment_orders'::regclass, 'whispers'::regclass)
				and contype = 'c'
				and (pg_get_constraintdef(oid) like '%octet_length(product_payload)%' or pg_get_constraintdef(oid) like '%octet_length(ciphertext)%')
		`;
		expect(legacyLimits).toHaveLength(2);
		expect(legacyLimits.every(({ definition }) => definition.includes("4215276") && !definition.includes("16384"))).toBe(true);
		const ciphertext = Buffer.alloc(4_215_276, 7);
		await expect(sql`
			insert into payment_orders (idempotency_key, product, plan_id, product_payload, amount_sats)
			values ('whisper-large-order', 'whisper', 'spark', ${ciphertext}, 42)
		`).resolves.toBeDefined();
		await expect(sql`
			insert into whispers (public_id, plan_id, read_token_hash, ciphertext, expires_at)
			values (${`whisper_${"w".repeat(22)}`}, 'spark', 'read-hash', ${ciphertext}, clock_timestamp() + interval '7 days')
		`).resolves.toBeDefined();
		await expect(sql`
			insert into payment_orders (idempotency_key, product, plan_id, product_payload, amount_sats)
			values ('whisper-oversized-order', 'whisper', 'spark', ${Buffer.alloc(4_215_277, 7)}, 42)
		`).rejects.toMatchObject({ code: "23514" });
	});

	it("adds bounded WHISPER read counters while preserving legacy resources as one-read", async () => {
		const columns = await sql<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
			select column_name, column_default, is_nullable from information_schema.columns
			where table_name = 'whispers' and column_name in ('read_limit', 'read_count') order by column_name
		`;
		expect(columns).toEqual([
			{ column_name: "read_count", column_default: "0", is_nullable: "NO" },
			{ column_name: "read_limit", column_default: "1", is_nullable: "NO" },
		]);
		expect((await sql`select version from schema_migrations where version = '0010_whisper_multiread'`)).toHaveLength(1);
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

	it("reconciles legacy headers and stored byte counters before validating the constraint", async () => {
		const publicId = `catch_${randomUUID().replaceAll("-", "")}`;
		const [resource] = await sql<{ id: string }[]>`
			insert into catch_resources (
				public_id, plan_id, owner_token_hash, ingest_token_hash,
				request_limit, storage_limit_bytes, max_bytes_per_request, stored_bytes, expires_at
			) values (
				${publicId}, 'spark', 'owner', 'ingest',
				402, 23, ${16 * 1024}, 1, clock_timestamp() + interval '1 hour'
			) returning id
		`;
		expect(resource).toBeDefined();
		await sql`alter table catch_events drop constraint catch_events_headers_allowlist_check`;
		await sql`
			insert into catch_events (resource_id, sequence_number, content_type, headers, body)
			values
				(${resource!.id}, 1, 'text/plain', ${sql.json({ cookie: "secret", "x-request-id": "ok" })}, ${Buffer.from("x")}),
				(${resource!.id}, 2, 'text/plain', ${sql.json({ authorization: "secret", "x-request-id": "ok" })}, ${Buffer.from("y")})
		`;
		const migration4 = (await readFile(new URL("../../migrations/0004_catch_storage_hardening.sql", import.meta.url), "utf8"))
			.replace("INSERT INTO schema_migrations (version) VALUES ('0004_catch_storage_hardening') ON CONFLICT DO NOTHING;", "");
		await sql.unsafe(migration4).simple();
		await sql.unsafe(await readFile(new URL("../../migrations/0005_catch_storage_reconcile.sql", import.meta.url), "utf8")).simple();

		const [event] = await sql<{ headers: Record<string, string> }[]>`select headers from catch_events where resource_id = ${resource!.id}`;
		const [stored] = await sql<{ status: string; stored_bytes: string }[]>`select status, stored_bytes from catch_resources where id = ${resource!.id}`;
		expect(event?.headers).toEqual({ "x-request-id": "ok" });
		expect(await sql`select id from catch_events where resource_id = ${resource!.id}`).toHaveLength(1);
		expect(stored).toMatchObject({ status: "exhausted", stored_bytes: "23" });
	});

	it("adds ingest policy and event method provenance before the public-ingest migration", async () => {
		const [resourceColumn] = await sql<{ column_default: string; is_nullable: string }[]>`
			select column_default, is_nullable from information_schema.columns
			where table_name = 'catch_resources' and column_name = 'ingest_auth_required'
		`;
		const eventColumns = await sql<{ column_name: string; column_default: string }[]>`
			select column_name, column_default from information_schema.columns
			where table_name = 'catch_events' and column_name in ('method', 'authenticated') order by column_name
		`;
		expect(resourceColumn).toMatchObject({ column_default: "false", is_nullable: "NO" });
		expect(eventColumns.map(({ column_name }) => column_name)).toEqual(["authenticated", "method"]);
		expect((await sql`select version from schema_migrations where version = '0008_catch_flexible_ingest'`)).toHaveLength(1);
	});

	it("opens ingestion for all CATCH resources and stores IP metadata", async () => {
		const [resourceColumn] = await sql<{ column_default: string }[]>`
			select column_default from information_schema.columns
			where table_name = 'catch_resources' and column_name = 'ingest_auth_required'
		`;
		const eventColumns = await sql<{ column_name: string; data_type: string }[]>`
			select column_name, data_type from information_schema.columns
			where table_name = 'catch_events' and column_name in ('source_ip', 'ip_location') order by column_name
		`;
		expect(resourceColumn?.column_default).toBe("false");
		expect(eventColumns.map(({ column_name }) => column_name)).toEqual(["ip_location", "source_ip"]);
		expect((await sql`select version from schema_migrations where version = '0009_catch_ip_metadata'`)).toHaveLength(1);
		const [size] = await sql<{ bytes: number }[]>`select catch_event_stored_bytes('{}'::jsonb, ${Buffer.from("x")}, '8.8.8.8'::inet, '{"country":"US"}'::jsonb) as bytes`;
		expect(size?.bytes).toBeGreaterThan(1);
	});

	it("upgrades protected legacy resources to accept public ingestion", async () => {
		const legacyContainer = `the402machine-upgrade-test-${randomUUID()}`;
		let legacySql: ReturnType<typeof postgres> | undefined;
		try {
			docker("run", "--detach", "--rm", "--name", legacyContainer, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=the402machine_test", image);
			const port = docker("port", legacyContainer, "5432/tcp").split(":").at(-1);
			if (port === undefined) throw new Error("Could not determine PostgreSQL upgrade-test port");
			const legacyUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/the402machine_test`;
			for (let attempt = 0; attempt < 40; attempt += 1) {
				try { const probe = postgres(legacyUrl, { max: 1, connect_timeout: 1 }); await probe`select 1`; await probe.end(); break; }
				catch { if (attempt === 39) throw new Error("PostgreSQL upgrade-test container did not become ready"); await new Promise((resolve) => setTimeout(resolve, 250)); }
			}
			legacySql = postgres(legacyUrl, { max: 1 });
			for (const file of ["0001_catch.sql", "0004_catch_storage_hardening.sql", "0005_catch_storage_reconcile.sql", "0008_catch_flexible_ingest.sql"]) {
				await legacySql.unsafe(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8")).simple();
			}
			const publicId = `catch_${randomUUID().replaceAll("-", "")}`;
			await legacySql`
				insert into catch_resources (public_id, plan_id, owner_token_hash, ingest_token_hash, ingest_auth_required, request_limit, storage_limit_bytes, max_bytes_per_request, expires_at)
				values (${publicId}, 'spark', 'owner', 'ingest', true, 402, ${2 * 1024 * 1024}, ${64 * 1024}, clock_timestamp() + interval '1 hour')
			`;
			await legacySql.unsafe(await readFile(new URL("../../migrations/0009_catch_ip_metadata.sql", import.meta.url), "utf8")).simple();
			const [resource] = await legacySql<{ ingest_auth_required: boolean }[]>`select ingest_auth_required from catch_resources where public_id = ${publicId}`;
			expect(resource?.ingest_auth_required).toBe(false);
		} finally {
			await legacySql?.end();
			try { docker("rm", "--force", legacyContainer); } catch { /* container already removed */ }
		}
	}, 60_000);

	it("does not charge legacy events for absent IP metadata during migration", async () => {
		const legacyContainer = `the402machine-quota-upgrade-${randomUUID()}`;
		let legacySql: ReturnType<typeof postgres> | undefined;
		try {
			docker("run", "--detach", "--rm", "--name", legacyContainer, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=the402machine_test", image);
			const port = docker("port", legacyContainer, "5432/tcp").split(":").at(-1);
			if (port === undefined) throw new Error("Could not determine PostgreSQL quota-upgrade port");
			const legacyUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/the402machine_test`;
			for (let attempt = 0; attempt < 40; attempt += 1) {
				try { const probe = postgres(legacyUrl, { max: 1, connect_timeout: 1 }); await probe`select 1`; await probe.end(); break; }
				catch { if (attempt === 39) throw new Error("PostgreSQL quota-upgrade container did not become ready"); await new Promise((resolve) => setTimeout(resolve, 250)); }
			}
			legacySql = postgres(legacyUrl, { max: 1 });
			for (const file of ["0001_catch.sql", "0004_catch_storage_hardening.sql", "0005_catch_storage_reconcile.sql", "0008_catch_flexible_ingest.sql"]) await legacySql.unsafe(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8")).simple();
			const publicId = `catch_${randomUUID().replaceAll("-", "")}`;
			const [resource] = await legacySql<{ id: string }[]>`
				insert into catch_resources (public_id, plan_id, owner_token_hash, ingest_token_hash, request_limit, storage_limit_bytes, max_bytes_per_request, stored_bytes, expires_at)
				values (${publicId}, 'spark', 'owner', 'ingest', 402, 3, ${64 * 1024}, 3, clock_timestamp() + interval '1 hour') returning id
			`;
			await legacySql`insert into catch_events (resource_id, sequence_number, content_type, headers, body) values (${resource!.id}, 1, 'text/plain', '{}'::jsonb, ${Buffer.from("x")})`;
			await legacySql.unsafe(await readFile(new URL("../../migrations/0009_catch_ip_metadata.sql", import.meta.url), "utf8")).simple();
			const [upgraded] = await legacySql<{ stored_bytes: string }[]>`select stored_bytes from catch_resources where id = ${resource!.id}`;
			expect(upgraded?.stored_bytes).toBe("3");
		} finally {
			await legacySql?.end();
			try { docker("rm", "--force", legacyContainer); } catch { /* container already removed */ }
		}
	}, 60_000);
});
