import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PaymentRepository } from "../../src/payment/payment-repository.js";

const image = "postgres:17-alpine";
const container = `the402machine-payment-test-${randomUUID()}`;
const password = "payment-test-password";
let databaseUrl = "";
let sql: ReturnType<typeof postgres>;
let repository: PaymentRepository;
const deliveryKey = Buffer.alloc(32, 7).toString("base64url");

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
	throw new Error("PostgreSQL payment test container did not become ready");
};

beforeAll(async () => {
	docker("pull", image);
	docker("run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=the402machine_test", image);
	const port = docker("port", container, "5432/tcp").split(":").at(-1);
	if (port === undefined) throw new Error("Could not determine PostgreSQL test port");
	databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/the402machine_test`;
	await waitForPostgres();
	sql = postgres(databaseUrl, { max: 1 });
	for (const migrationName of ["0001_catch.sql", "0002_payments.sql", "0003_whisper.sql", "0006_payment_pricing_v2.sql", "0007_whisper_payload_v2.sql", "0010_whisper_multiread.sql", "0011_whisper_burn_after_read.sql", "0012_pulse.sql", "0013_whisper_scheduled_reveal.sql", "0014_whisper_reveal_window.sql"]) {
		const migration = await readFile(new URL(`../../migrations/${migrationName}`, import.meta.url), "utf8");
		await sql.unsafe(migration).simple();
	}
	await sql.end();
	sql = postgres(databaseUrl, { max: 12 });
	repository = new PaymentRepository(sql, deliveryKey);
}, 60_000);

afterAll(async () => {
	await sql?.end();
	try { docker("rm", "--force", container); } catch { /* container already removed */ }
});

describe("PaymentRepository", () => {
	it("returns the same order for one idempotency key", async () => {
		const first = await repository.createOrder({ idempotencyKey: "idem-same", planId: "spark" });
		const second = await repository.createOrder({ idempotencyKey: "idem-same", planId: "spark" });
		expect(second.id).toBe(first.id);
	});

	it("prices all three currently available plans", async () => {
		const ciphertext = Buffer.concat([Buffer.from([1]), Buffer.alloc(29, 7)]);
		const burn = await repository.createOrder({ idempotencyKey: "idem-whisper-burn-policy", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 1 });
		const repeated = await repository.createOrder({ idempotencyKey: "idem-whisper-burn-policy", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 1 });
		expect(burn.whisperReadLimit).toBe(1);
		expect(repeated.id).toBe(burn.id);
		await expect(repository.createOrder({ idempotencyKey: "idem-whisper-burn-policy", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42 })).rejects.toThrow("Idempotency key already belongs to another purchase");

		const spark = await repository.createOrder({ idempotencyKey: "idem-price-spark", planId: "spark" });
		const standard = await repository.createOrder({ idempotencyKey: "idem-price-standard", planId: "standard" });
		const long = await repository.createOrder({ idempotencyKey: "idem-price-long", planId: "long" });
		expect([spark.amountSats, standard.amountSats, long.amountSats]).toEqual([42, 402, 4_002]);
	});

	it("treats a scheduled WHISPER reveal as immutable idempotency identity", async () => {
		const ciphertext = Buffer.concat([Buffer.from([1]), Buffer.alloc(29, 7)]);
		const revealAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
		const first = await repository.createOrder({ idempotencyKey: "idem-whisper-schedule", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42, whisperRevealAt: revealAt });
		const repeated = await repository.createOrder({ idempotencyKey: "idem-whisper-schedule", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42, whisperRevealAt: new Date(revealAt) });
		expect(first.whisperRevealAt?.toISOString()).toBe(revealAt.toISOString());
		expect(repeated.id).toBe(first.id);
		await expect(repository.createOrder({ idempotencyKey: "idem-whisper-schedule", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42, whisperRevealAt: new Date(revealAt.getTime() + 1_000) })).rejects.toThrow("Idempotency key already belongs to another purchase");
		await expect(repository.createOrder({ idempotencyKey: "idem-whisper-schedule", product: "whisper", planId: "standard", productPayload: ciphertext, whisperReadLimit: 42, whisperRevealAt: null })).rejects.toThrow("Idempotency key already belongs to another purchase");
	});

	it("claims one payment hash for only one order", async () => {
		const first = await repository.createOrder({ idempotencyKey: "idem-first", planId: "spark" });
		const second = await repository.createOrder({ idempotencyKey: "idem-second", planId: "spark" });
		await repository.attachInvoice(first.id, { paymentHash: "a".repeat(64), bolt11: "lnbc1first" });
		await expect(repository.attachInvoice(second.id, { paymentHash: "a".repeat(64), bolt11: "lnbc1second" })).rejects.toMatchObject({ code: "23505" });
	});

	it("creates only one invoice under concurrent idempotent requests", async () => {
		const order = await repository.createOrder({ idempotencyKey: "idem-invoice-once", planId: "spark" });
		let calls = 0;
		const results = await Promise.all(Array.from({ length: 8 }, () => repository.ensureInvoice(order.id, () => {
			calls += 1;
			return Promise.resolve({ paymentHash: "c".repeat(64), bolt11: "lnbc4n1once" });
		})));
		expect(calls).toBe(1);
		expect(results.every((result) => result.bolt11 === "lnbc4n1once")).toBe(true);
	});

	it("dispenses exactly once under concurrent verification", async () => {
		const order = await repository.createOrder({ idempotencyKey: "idem-dispense", planId: "spark" });
		await repository.attachInvoice(order.id, { paymentHash: "b".repeat(64), bolt11: "lnbc1paid" });
		await repository.markPaid(order.id);
		const calls: string[] = [];
		const results = await Promise.all(Array.from({ length: 8 }, () => repository.dispensePaidOrder(order.id, (lockedOrder) => {
			calls.push(lockedOrder.id);
			return Promise.resolve({
				product: "catch" as const,
				publicId: "catch_payment_repository_once", planId: "spark", ownerTokenHash: "owner-hash", ingestTokenHash: "ingest-hash",
				requestLimit: 402, storageLimitBytes: 2 * 1024 * 1024, maxBytesPerRequest: 64 * 1024,
				ownerToken: "owner-once", ingestToken: "ingest-once", expiresAt: new Date(Date.now() + 60_000),
			});
		})));

		expect(calls).toHaveLength(1);
		expect(results.every((result) => result?.publicId === "catch_payment_repository_once")).toBe(true);
		expect(results.every((result) => result?.product === "catch" && result.ownerToken === "owner-once" && result.ingestToken === "ingest-once")).toBe(true);
		const resourceCount = await sql<{ count: number }[]>`select count(*)::int as count from catch_resources where public_id = 'catch_payment_repository_once'`;
		expect(resourceCount[0]?.count).toBe(1);
	});

	it("atomically dispenses an idempotent WHISPER delivery", async () => {
		const ciphertext = Buffer.concat([Buffer.from([1]), Buffer.alloc(29, 7)]);
		const order = await repository.createOrder({ idempotencyKey: "idem-whisper-dispense", product: "whisper", planId: "spark", productPayload: ciphertext });
		await repository.attachInvoice(order.id, { paymentHash: "e".repeat(64), bolt11: "lnbc4n1whisper" });
		await repository.markPaid(order.id);
		const revealAt = new Date();
		const results = await Promise.all(Array.from({ length: 4 }, () => repository.dispensePaidOrder(order.id, () => Promise.resolve({
			product: "whisper", publicId: "whisper_payment_once_abcdefghijklmnopqrstuv", planId: "spark", readTokenHash: "read-hash", readLimit: 1,
			ciphertext, readToken: "read-once", revealAt, expiresAt: new Date(revealAt.getTime() + 2 * 60 * 60 * 1_000),
		}))));
		expect(results.every((result) => result?.product === "whisper" && result.readToken === "read-once")).toBe(true);
		const rows = await sql<{ count: number }[]>`select count(*)::int as count from whispers where public_id = 'whisper_payment_once_abcdefghijklmnopqrstuv'`;
		expect(rows[0]?.count).toBe(1);
	});


	it("atomically dispenses an idempotent PULSE delivery", async () => {
		const order = await repository.createOrder({ idempotencyKey: "idem-pulse-dispense", product: "pulse", planId: "spark" });
		await repository.attachInvoice(order.id, { paymentHash: "f".repeat(64), bolt11: "lnbc42n1pulse" });
		await repository.markPaid(order.id);
		const results = await Promise.all(Array.from({ length: 4 }, () => repository.dispensePaidOrder(order.id, () => Promise.resolve({ product: "pulse", publicId: "pulse_payment_once_abcdefghijklmnopqrstuv", planId: "spark", ownerTokenHash: "a".repeat(64), pingTokenHash: "b".repeat(64), heartbeatLimit: 1_202, expectedIntervalSeconds: 300, graceSeconds: 600, ownerToken: "pulse-owner", pingToken: "pulse-ping", expiresAt: new Date(Date.now() + 60_000) }))));
		expect(results.every((result) => result?.product === "pulse" && result.ownerToken === "pulse-owner" && result.pingToken === "pulse-ping")).toBe(true);
		expect((await sql`select id from pulse_resources where public_id = 'pulse_payment_once_abcdefghijklmnopqrstuv'`)).toHaveLength(1);
	});

	it("consumes a PULSE quota atomically and erases the ping capability at exhaustion", async () => {
		const publicId = "pulse_quota_once_abcdefghijklmnopqrstuv";
		await sql`
			insert into pulse_resources (public_id, plan_id, owner_token_hash, ping_token_hash, heartbeat_limit, expected_interval_seconds, grace_seconds, expires_at)
			values (${publicId}, 'spark', ${"a".repeat(64)}, ${"b".repeat(64)}, 3, 300, 600, clock_timestamp() + interval '1 hour')
		`;
		const pulse = new (await import("../../src/pulse/pulse-repository.js")).PulseRepository(sql);
		const results = await Promise.all(Array.from({ length: 8 }, () => pulse.acceptHeartbeat(publicId)));
		expect(results.filter(({ accepted }) => accepted)).toHaveLength(3);
		expect(results.filter((result) => !result.accepted)).toHaveLength(5);
		expect(await pulse.getResource(publicId)).toMatchObject({ status: "exhausted", heartbeatCount: 3, heartbeatLimit: 3 });
		expect(await pulse.getCredentialHashes(publicId)).toEqual({ ownerTokenHash: "a".repeat(64), pingTokenHash: null });
	});

	it("stores a WHISPER payment payload near 4.02 MiB", async () => {
		const ciphertext = Buffer.alloc(4_215_276, 7);
		ciphertext[0] = 1;
		const order = await repository.createOrder({ idempotencyKey: "idem-whisper-large", product: "whisper", planId: "spark", productPayload: ciphertext });
		expect(order.productPayload?.byteLength).toBe(4_215_276);
		await expect(repository.createOrder({ idempotencyKey: "idem-whisper-too-large", product: "whisper", planId: "spark", productPayload: Buffer.alloc(4_215_277, 7) })).rejects.toThrow("WHISPER ciphertext is invalid");
	});
});