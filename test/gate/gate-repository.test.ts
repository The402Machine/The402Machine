import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GateRepository } from "../../src/gate/gate-repository.js";
import { startPostgresTestContainer, type PostgresTestContainer } from "../support/postgres-container.js";

const container = `the402machine-gate-test-${randomUUID()}`;
let sql: ReturnType<typeof postgres>;
let repository: GateRepository;
let postgresContainer: PostgresTestContainer;

beforeAll(async () => {
	postgresContainer = await startPostgresTestContainer({ name: container, password: "gate-test-password" });
	sql = postgres(postgresContainer.databaseUrl, { max: 12 });
	for (const migrationName of ["0001_catch.sql", "0020_gate.sql"]) {
		await sql.unsafe(await readFile(new URL(`../../migrations/${migrationName}`, import.meta.url), "utf8")).simple();
	}
	repository = new GateRepository(sql);
}, 60_000);

afterAll(async () => {
	await sql?.end();
	postgresContainer?.stop();
});

async function createProject(suffix: string) {
	return repository.createProject({
		publicId: `gate_project_${suffix.padEnd(22, "x")}`,
		displayName: "Agent API",
		lightningAddress: `${suffix}@example.com`,
		adminTokenHash: "a".repeat(64),
		apiTokenHash: "b".repeat(64),
	});
}

async function createRoute(projectId: string, suffix: string) {
	return repository.createRoute({ projectId, routeKey: `route-${suffix}`, method: "POST", path: `/v1/${suffix}`, priceSats: 42 });
}

describe("GateRepository", () => {
	it("creates isolated projects and fixed-price routes", async () => {
		const project = await createProject("isolated");
		const route = await createRoute(project.id, "weather");
		expect(project).toMatchObject({ displayName: "Agent API", lightningAddress: "isolated@example.com", monthlyFreeLimit: 25, active: true });
		expect(route).toMatchObject({ projectId: project.id, routeKey: "route-weather", method: "POST", path: "/v1/weather", priceSats: 42, active: true });
	});

	it("authenticates only the matching active project API hash", async () => {
		const project = await repository.createProject({ publicId: `gate_project_${randomUUID().replaceAll("-", "")}`, displayName: "Auth", lightningAddress: "auth@example.com", adminTokenHash: "a".repeat(64), apiTokenHash: "b".repeat(64) });
		expect((await repository.authenticateProjectApi(project.publicId, "b".repeat(64)))?.id).toBe(project.id);
		expect(await repository.authenticateProjectApi(project.publicId, "c".repeat(64))).toBeNull();
		await sql`update gate_projects set active = false where id = ${project.id}`;
		expect(await repository.authenticateProjectApi(project.publicId, "b".repeat(64))).toBeNull();
	});

	it("returns one intent for the same exact idempotent binding and rejects drift", async () => {
		const project = await createProject("idem");
		const route = await createRoute(project.id, "idem");
		const input = { publicId: `gate_intent_${"i".repeat(24)}`, projectId: project.id, routeId: route.id, idempotencyKey: "intent-idempotency-1", method: "POST" as const, path: "/v1/idem", bodyDigest: "c".repeat(64), amountSats: 42, lightningAddress: "idem@example.com" };
		const first = await repository.createIntent(input);
		const repeated = await repository.createIntent({ ...input, publicId: `gate_intent_${"j".repeat(24)}` });
		expect(repeated.id).toBe(first.id);
		await expect(repository.createIntent({ ...input, publicId: `gate_intent_${"k".repeat(24)}`, bodyDigest: "d".repeat(64) })).rejects.toThrow(/another request/u);
	});

	it("attaches one invoice and never reassigns a payment hash", async () => {
		const project = await createProject("invoice");
		const route = await createRoute(project.id, "invoice");
		const first = await repository.createIntent({ publicId: `gate_intent_${"l".repeat(24)}`, projectId: project.id, routeId: route.id, idempotencyKey: "invoice-first-key", method: "POST", path: "/v1/invoice", bodyDigest: "e".repeat(64), amountSats: 42, lightningAddress: "invoice@example.com" });
		const second = await repository.createIntent({ publicId: `gate_intent_${"m".repeat(24)}`, projectId: project.id, routeId: route.id, idempotencyKey: "invoice-second-key", method: "POST", path: "/v1/invoice", bodyDigest: "f".repeat(64), amountSats: 42, lightningAddress: "invoice@example.com" });
		const expiresAt = new Date(Date.now() + 600_000);
		expect(await repository.attachInvoice(first.id, { bolt11: "lnbc42first", paymentHash: "1".repeat(64), expiresAt, verifyUrl: null })).toMatchObject({ state: "invoice_issued", paymentHash: "1".repeat(64) });
		await expect(repository.attachInvoice(first.id, { bolt11: "lnbc42different", paymentHash: "2".repeat(64), expiresAt, verifyUrl: null })).rejects.toThrow(/not awaiting/u);
		await expect(repository.attachInvoice(second.id, { bolt11: "lnbc42second", paymentHash: "1".repeat(64), expiresAt, verifyUrl: null })).rejects.toMatchObject({ code: "23505" });
	});

	it("uses 25 UTC monthly authorizations, then consumes the earliest prepaid grant", async () => {
		const project = await createProject("quota");
		const route = await createRoute(project.id, "quota");
		const grant = await repository.addCreditGrant({ projectId: project.id, sourceOrderId: randomUUID(), packId: "spark", purchasedAt: new Date("2026-08-01T00:00:00Z"), expiresAt: new Date("2027-09-07T00:00:00Z") });
		const now = new Date("2026-08-11T12:00:00Z");
		const authorizations = [];
		for (let index = 0; index < 26; index += 1) {
			const intent = await repository.createIntent({ publicId: `gate_intent_${index.toString().padStart(24, "0")}`, projectId: project.id, routeId: route.id, idempotencyKey: `quota-intent-${index}`, method: "POST", path: "/v1/quota", bodyDigest: index.toString(16).padStart(64, "0"), amountSats: 42, lightningAddress: "quota@example.com" });
			await repository.attachInvoice(intent.id, { bolt11: `lnbc42quota${index}`, paymentHash: index.toString(16).padStart(64, "a"), expiresAt: new Date("2026-08-12T00:00:00Z"), verifyUrl: null });
			await repository.markPaid(intent.id, now);
			authorizations.push(await repository.authorizeIntent({ intentId: intent.id, receiptJti: `receipt_${index.toString().padStart(35, "0")}`, now, createReceipt: () => "signed." + "x".repeat(80) }));
		}
		expect(authorizations.slice(0, 25).every((authorization) => authorization?.source === "monthly_free")).toBe(true);
		expect(authorizations[25]).toMatchObject({ source: "prepaid_grant", grantId: grant.id });
		expect(await repository.getCreditGrant(grant.id)).toMatchObject({ remainingAuthorizations: 419 });
	});

	it("authorizes one concurrent verification once and safely returns the same receipt", async () => {
		const project = await createProject("concurrent");
		const route = await createRoute(project.id, "concurrent");
		const intent = await repository.createIntent({ publicId: `gate_intent_${"n".repeat(24)}`, projectId: project.id, routeId: route.id, idempotencyKey: "concurrent-intent", method: "POST", path: "/v1/concurrent", bodyDigest: "9".repeat(64), amountSats: 42, lightningAddress: "concurrent@example.com" });
		await repository.attachInvoice(intent.id, { bolt11: "lnbc42concurrent", paymentHash: "8".repeat(64), expiresAt: new Date(Date.now() + 600_000), verifyUrl: null });
		const now = new Date();
		await repository.markPaid(intent.id, now);
		const results = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.authorizeIntent({ intentId: intent.id, receiptJti: `concurrent_${index.toString().padStart(32, "0")}`, now, createReceipt: (jti: string) => `signed.${jti}.${"x".repeat(80)}` })));
		expect(new Set(results.map((result) => result?.receiptJti)).size).toBe(1);
		expect((await sql<{ count: number }[]>`select count(*)::int as count from gate_authorizations where intent_id = ${intent.id}`)[0]?.count).toBe(1);
	});

	it("fails closed when monthly and prepaid entitlements are exhausted", async () => {
		const project = await createProject("exhausted");
		const route = await createRoute(project.id, "exhausted");
		await sql`update gate_projects set monthly_free_limit = 25 where id = ${project.id}`;
		for (let index = 0; index < 25; index += 1) {
			const [intent] = await sql<{ id: string }[]>`insert into gate_intents (public_id, project_id, route_id, idempotency_key, method, path, body_digest, amount_sats, lightning_address, state, bolt11, payment_hash, receipt, invoice_expires_at, paid_at, authorized_at) values (${`gate_intent_seed_${index.toString().padStart(20, "0")}`}, ${project.id}, ${route.id}, ${`seed-key-${index}`}, 'POST', '/v1/exhausted', ${index.toString(16).padStart(64, "0")}, 42, 'exhausted@example.com', 'authorized', ${`lnbcseed${index}`}, ${index.toString(16).padStart(64, "b")}, ${`signed.seed.${"x".repeat(80)}`}, clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp()) returning id`;
			await sql`insert into gate_authorizations (intent_id, receipt_jti, source, source_month, project_id) values (${intent!.id}, ${`seed_${index.toString().padStart(38, "0")}`}, 'monthly_free', date '2026-08-01', ${project.id})`;
		}
		const intent = await repository.createIntent({ publicId: `gate_intent_${"z".repeat(24)}`, projectId: project.id, routeId: route.id, idempotencyKey: "quota-exhausted-final", method: "POST", path: "/v1/exhausted", bodyDigest: "7".repeat(64), amountSats: 42, lightningAddress: "exhausted@example.com" });
		await repository.attachInvoice(intent.id, { bolt11: "lnbc42exhausted", paymentHash: "6".repeat(64), expiresAt: new Date("2026-08-12T00:00:00Z"), verifyUrl: null });
		await repository.markPaid(intent.id, new Date("2026-08-11T12:00:00Z"));
		await expect(repository.authorizeIntent({ intentId: intent.id, receiptJti: `receipt_${"x".repeat(35)}`, now: new Date("2026-08-11T12:00:00Z"), createReceipt: () => "signed." + "x".repeat(80) })).rejects.toThrow(/No GATE authorizations available/u);
		expect((await repository.getIntent(intent.id))?.state).toBe("paid");
	});
});
