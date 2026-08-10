import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StatsRepository } from "../../src/stats/stats-repository.js";
import { startPostgresTestContainer, type PostgresTestContainer } from "../support/postgres-container.js";

const container = `the402machine-stats-test-${randomUUID()}`;
const password = "stats-test-password";
let sql: ReturnType<typeof postgres>;
let postgresContainer: PostgresTestContainer;
let repository: StatsRepository;

beforeAll(async () => {
	postgresContainer = await startPostgresTestContainer({ name: container, password });
	sql = postgres(postgresContainer.databaseUrl, { max: 1 });
	for (const migrationName of ["0001_catch.sql", "0002_payments.sql", "0003_whisper.sql", "0006_payment_pricing_v2.sql", "0007_whisper_payload_v2.sql", "0010_whisper_multiread.sql", "0011_whisper_burn_after_read.sql", "0012_pulse.sql", "0013_whisper_scheduled_reveal.sql", "0014_whisper_reveal_window.sql", "0015_whisper_custom_read_limit.sql", "0016_pulse_public_status_id.sql", "0017_payment_challenges.sql", "0018_platform_events.sql", "0019_page_views.sql"]) {
		await sql.unsafe(await readFile(new URL(`../../migrations/${migrationName}`, import.meta.url), "utf8")).simple();
	}
	repository = new StatsRepository(sql);
}, 60_000);

afterAll(async () => {
	await sql?.end();
	postgresContainer?.stop();
});

describe("StatsRepository", () => {
	it("returns only aggregate paid and dispensed counters", async () => {
		await repository.recordPageView("/");
		await repository.recordPageView("/stats");
		const catchOrderId = randomUUID();
		await sql`
			insert into platform_events (order_id, event_type, product, plan_id, amount_sats, occurred_at)
			values
				(${catchOrderId}, 'payment_paid', 'catch', 'spark', 42, clock_timestamp()),
				(${randomUUID()}, 'payment_paid', 'whisper', 'standard', 402, clock_timestamp()),
				(${catchOrderId}, 'resource_dispensed', 'catch', 'spark', 42, clock_timestamp())
		`;
		expect(await repository.getPublicStats()).toEqual({
			pageViews: 2,
			viewsToday: 2,
			viewsLast7Days: 2,
			paidPayments: 2,
			dispensedResources: 1,
			receivedSats: 444,
			byProduct: {
				catch: { paidPayments: 1, dispensedResources: 1, receivedSats: 42 },
				whisper: { paidPayments: 1, dispensedResources: 0, receivedSats: 402 },
				pulse: { paidPayments: 0, dispensedResources: 0, receivedSats: 0 },
			},
		});
	});

	it("stores only daily counters for approved public pages", async () => {
		await repository.recordPageView("/api");
		await repository.recordPageView("/api");
		await repository.recordPageView("/catch");
		const rows = await sql<{ path: string; views: string }[]>`select path, views::text from page_view_daily order by path`;
		expect(rows).toEqual([
			{ path: "/", views: "1" },
			{ path: "/api", views: "2" },
			{ path: "/catch", views: "1" },
			{ path: "/stats", views: "1" },
		]);
		const columns = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'page_view_daily' order by column_name`;
		expect(columns.map((column) => column.column_name)).toEqual(["day", "path", "views"]);
	});

	it("supports aggregate values above PostgreSQL int32", async () => {
		await sql`
			insert into platform_events (order_id, event_type, product, plan_id, amount_sats, occurred_at)
			values
				(${randomUUID()}, 'payment_paid', 'pulse', 'long', 1_500_000_000, clock_timestamp()),
				(${randomUUID()}, 'payment_paid', 'pulse', 'long', 1_500_000_000, clock_timestamp())
		`;
		const stats = await repository.getPublicStats();
		expect(stats.receivedSats).toBe(3_000_000_444);
		expect(stats.byProduct.pulse.receivedSats).toBe(3_000_000_000);
	});
});
