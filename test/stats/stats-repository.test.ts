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
	it("returns historical totals, period totals, per-plan totals, and 30 days of activity", async () => {
		await sql`insert into page_view_daily (day, path, views) values ((timezone('UTC', clock_timestamp()))::date - 1, '/api', 1)`;
		await repository.recordPageView("/");
		await repository.recordPageView("/stats");
		const catchOrderId = randomUUID();
		const whisperOrderId = randomUUID();
		const pulseOrderId = randomUUID();
		const historicalOrderId = randomUUID();
		await sql`
			insert into payment_orders (id, idempotency_key, product, plan_id, product_payload, amount_sats, status, payment_hash, bolt11, resource_id, delivery_ciphertext, created_at, invoice_issued_at, paid_at, dispensed_at)
			values
				(${catchOrderId}, 'stats-catch-order', 'catch', 'spark', null, 42, 'dispensed', ${"a".repeat(64)}, 'lnbc42statscatch', ${randomUUID()}, ${Buffer.alloc(29, 1)}, clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day'),
				(${whisperOrderId}, 'stats-whisper-order', 'whisper', 'standard', ${Buffer.alloc(30, 2)}, 402, 'paid', ${"b".repeat(64)}, 'lnbc402statswhisper', null, null, clock_timestamp(), clock_timestamp(), clock_timestamp(), null),
				(${pulseOrderId}, 'stats-pulse-order', 'pulse', 'long', null, 4002, 'invoice_issued', ${"c".repeat(64)}, 'lnbc4002statspulse', null, null, clock_timestamp(), clock_timestamp(), null, null),
				(${historicalOrderId}, 'stats-historical-order', 'catch', 'long', null, 4002, 'invoice_issued', ${"f".repeat(64)}, 'lnbc4002statshistorical', null, null, clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days', null, null)
		`;
		const stats = await repository.getPublicStats();
		expect(stats).toMatchObject({
			pageViews: 3,
			viewsToday: 2,
			viewsLast7Days: 3,
			quotesIssued: 4,
			paidPayments: 2,
			dispensedResources: 1,
			receivedSats: 444,
			funnel: {
				trackingStartedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
				pageViews: 3,
				quotesIssued: 4,
				paidPayments: 2,
				dispensedResources: 1,
				visitToQuotePercent: 133.3,
				quoteToPaidPercent: 50,
				paidToDispensedPercent: 50,
			},
			periods: {
				all: { pageViews: 3, quotesIssued: 4, paidPayments: 2, dispensedResources: 1, receivedSats: 444 },
				today: { pageViews: 2, quotesIssued: 2, paidPayments: 1, dispensedResources: 0, receivedSats: 402 },
				last7Days: { pageViews: 3, quotesIssued: 3, paidPayments: 2, dispensedResources: 1, receivedSats: 444 },
				last30Days: { pageViews: 3, quotesIssued: 4, paidPayments: 2, dispensedResources: 1, receivedSats: 444 },
			},
			byProduct: {
				catch: { quotesIssued: 2, paidPayments: 1, dispensedResources: 1, receivedSats: 42 },
				whisper: { quotesIssued: 1, paidPayments: 1, dispensedResources: 0, receivedSats: 402 },
				pulse: { quotesIssued: 1, paidPayments: 0, dispensedResources: 0, receivedSats: 0 },
			},
		});
		expect(stats.byProduct.catch.byPlan.spark).toEqual({ quotesIssued: 1, paidPayments: 1, dispensedResources: 1, receivedSats: 42 });
		expect(stats.byProduct.catch.byPlan.long).toEqual({ quotesIssued: 1, paidPayments: 0, dispensedResources: 0, receivedSats: 0 });
		expect(stats.byProduct.whisper.byPlan.standard).toEqual({ quotesIssued: 1, paidPayments: 1, dispensedResources: 0, receivedSats: 402 });
		expect(stats.byProduct.pulse.byPlan.long).toEqual({ quotesIssued: 1, paidPayments: 0, dispensedResources: 0, receivedSats: 0 });
		expect(stats.activityLast30Days).toHaveLength(30);
		expect(stats.activityLast30Days.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), pageViews: 2, quotesIssued: 2, paidPayments: 1, dispensedResources: 0 });
		expect(stats.activityLast30Days.at(-2)).toEqual({ day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), pageViews: 1, quotesIssued: 1, paidPayments: 1, dispensedResources: 1 });
		expect(stats.activityLast30Days.at(-11)).toEqual({ day: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10), pageViews: 0, quotesIssued: 1, paidPayments: 0, dispensedResources: 0 });
		expect(stats.funnel.quotesIssued).toBeLessThanOrEqual(stats.activityLast30Days.reduce((sum, day) => sum + day.quotesIssued, 0));
	});

	it("stores only daily counters for approved public pages", async () => {
		await repository.recordPageView("/api");
		await repository.recordPageView("/api");
		await repository.recordPageView("/catch");
		const rows = await sql<{ path: string; views: string }[]>`select path, views::text from page_view_daily where day = (timezone('UTC', clock_timestamp()))::date order by path`;
		expect(rows).toEqual([
			{ path: "/", views: "1" },
			{ path: "/api", views: "2" },
			{ path: "/catch", views: "1" },
			{ path: "/stats", views: "1" },
		]);
		const columns = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'page_view_daily' order by column_name`;
		expect(columns.map((column) => column.column_name)).toEqual(["day", "path", "views"]);
	});

	it("keeps historical orders in all-time and rolling periods even when page-view tracking started later", async () => {
		await sql`begin`;
		try {
			await sql`delete from page_view_daily`;
			await sql`delete from payment_orders`;
			await repository.recordPageView("/stats");
			await sql`
				insert into payment_orders (idempotency_key, product, plan_id, amount_sats, status, payment_hash, bolt11, resource_id, delivery_ciphertext, invoice_issued_at, paid_at, dispensed_at)
				values ('stats-pre-tracking-payment', 'catch', 'spark', 42, 'dispensed', ${"8".repeat(64)}, 'lnbc42pretracking', ${randomUUID()}, ${Buffer.alloc(29, 8)},
					clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days')
			`;
			const stats = await repository.getPublicStats();
			expect(stats.periods.all).toEqual({ pageViews: 1, quotesIssued: 1, paidPayments: 1, dispensedResources: 1, receivedSats: 42 });
			expect(stats.periods.last30Days).toEqual({ pageViews: 1, quotesIssued: 1, paidPayments: 1, dispensedResources: 1, receivedSats: 42 });
			expect(stats.periods.last7Days).toEqual({ pageViews: 1, quotesIssued: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0 });
		} finally {
			await sql`rollback`;
		}
	});

	it("uses UTC day boundaries even when the PostgreSQL session timezone is not UTC", async () => {
		await sql`set time zone 'Pacific/Honolulu'`;
		try {
			await sql`insert into page_view_daily (day, path, views) values ((timezone('UTC', clock_timestamp()))::date, '/api', 1) on conflict (day, path) do update set views = page_view_daily.views + 1`;
			const resourceId = randomUUID();
			await sql`
				insert into payment_orders (idempotency_key, product, plan_id, amount_sats, status, payment_hash, bolt11, resource_id, delivery_ciphertext, invoice_issued_at, paid_at, dispensed_at)
				values ('stats-utc-boundary', 'catch', 'spark', 42, 'dispensed', ${"9".repeat(64)}, 'lnbc42utcboundary', ${resourceId}, ${Buffer.alloc(29, 9)},
					(date_trunc('day', timezone('UTC', clock_timestamp())) + interval '30 minutes') at time zone 'UTC',
					(date_trunc('day', timezone('UTC', clock_timestamp())) + interval '30 minutes') at time zone 'UTC',
					(date_trunc('day', timezone('UTC', clock_timestamp())) + interval '30 minutes') at time zone 'UTC')
			`;
			const stats = await repository.getPublicStats();
			expect(stats.periods.today).toMatchObject({ quotesIssued: 3, paidPayments: 2, dispensedResources: 1, receivedSats: 444 });
		} finally {
			await sql`delete from payment_orders where idempotency_key = 'stats-utc-boundary'`;
			await sql`set time zone 'UTC'`;
		}
	});

	it("supports aggregate values above PostgreSQL int32", async () => {
		await sql`alter table payment_orders drop constraint payment_orders_price_check`;
		try {
			await sql`
				insert into payment_orders (idempotency_key, product, plan_id, amount_sats, status, payment_hash, bolt11, invoice_issued_at, paid_at)
				values
					('stats-large-pulse-one', 'pulse', 'long', 1_500_000_000, 'paid', ${"d".repeat(64)}, 'lnbc1500000000largeone', clock_timestamp(), clock_timestamp()),
					('stats-large-pulse-two', 'pulse', 'long', 1_500_000_000, 'paid', ${"e".repeat(64)}, 'lnbc1500000000largetwo', clock_timestamp(), clock_timestamp())
			`;
			const stats = await repository.getPublicStats();
			expect(stats.receivedSats).toBe(3_000_000_444);
			expect(stats.byProduct.pulse.receivedSats).toBe(3_000_000_000);
		} finally {
			await sql`delete from payment_orders where idempotency_key in ('stats-large-pulse-one', 'stats-large-pulse-two')`;
		}
	});
});
