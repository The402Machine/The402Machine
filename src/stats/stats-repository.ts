import type { Sql } from "postgres";

import type { PaymentProduct, PurchasableCatchPlanId } from "../payment/payment-domain.js";

export type PlanStats = {
	quotesIssued: number;
	paidPayments: number;
	dispensedResources: number;
	receivedSats: number;
};

export type ProductStats = PlanStats & {
	byPlan: Record<PurchasableCatchPlanId, PlanStats>;
};

export type DailyActivity = {
	day: string;
	pageViews: number;
	quotesIssued: number;
	paidPayments: number;
	dispensedResources: number;
};

export type PlatformStats = {
	pageViews: number;
	viewsToday: number;
	viewsLast7Days: number;
	quotesIssued: number;
	paidPayments: number;
	dispensedResources: number;
	receivedSats: number;
	funnel: {
		trackingStartedOn: string | null;
		pageViews: number;
		quotesIssued: number;
		paidPayments: number;
		dispensedResources: number;
		visitToQuotePercent: number;
		quoteToPaidPercent: number;
		paidToDispensedPercent: number;
	};
	activityLast30Days: DailyActivity[];
	byProduct: Record<PaymentProduct, ProductStats>;
};

type StatsRow = {
	product: PaymentProduct;
	plan_id: PurchasableCatchPlanId;
	quotes_issued: string;
	paid_payments: string;
	dispensed_resources: string;
	received_sats: string;
};

type PageViewRow = {
	page_views: string;
	views_today: string;
	views_last_7_days: string;
	tracking_started_on: string | Date | null;
};

type DailyActivityRow = {
	day: string | Date;
	page_views: string;
	quotes_issued: string;
	paid_payments: string;
	dispensed_resources: string;
};

export class StatsRepository {
	public constructor(private readonly sql: Sql) {}

	public async recordPageView(path: string): Promise<void> {
		await this.sql`
			insert into page_view_daily (day, path, views)
			values ((timezone('UTC', clock_timestamp()))::date, ${path}, 1)
			on conflict (day, path) do update set views = page_view_daily.views + 1
		`;
	}

	public async getPublicStats(): Promise<PlatformStats> {
		const [rows, pageViewRows, activityRows] = await Promise.all([
			this.sql<StatsRow[]>`
				with tracking as (select min(day) as started_on from page_view_daily)
				select
					product,
					plan_id,
					count(*) filter (where invoice_issued_at >= tracking.started_on) as quotes_issued,
					count(*) filter (where paid_at >= tracking.started_on) as paid_payments,
					count(*) filter (where dispensed_at >= tracking.started_on) as dispensed_resources,
					coalesce(sum(amount_sats) filter (where paid_at >= tracking.started_on), 0) as received_sats
				from payment_orders cross join tracking
				where tracking.started_on is not null
				group by product, plan_id
			`,
			this.sql<PageViewRow[]>`
				select
					coalesce(sum(views), 0) as page_views,
					coalesce(sum(views) filter (where day = (timezone('UTC', clock_timestamp()))::date), 0) as views_today,
					coalesce(sum(views) filter (where day >= (timezone('UTC', clock_timestamp()))::date - 6), 0) as views_last_7_days,
					min(day)::text as tracking_started_on
				from page_view_daily
			`,
			this.sql<DailyActivityRow[]>`
				with days as (
					select generate_series(
						(timezone('UTC', clock_timestamp()))::date - 29,
						(timezone('UTC', clock_timestamp()))::date,
						interval '1 day'
					)::date as day
				), views as (
					select day, sum(views) as page_views from page_view_daily
					where day >= (timezone('UTC', clock_timestamp()))::date - 29
					group by day
				), quotes as (
					select (timezone('UTC', invoice_issued_at))::date as day, count(*) as quotes_issued
					from payment_orders
					where invoice_issued_at >= (timezone('UTC', clock_timestamp()))::date - 29
					group by (timezone('UTC', invoice_issued_at))::date
				), paid as (
					select (timezone('UTC', paid_at))::date as day, count(*) as paid_payments
					from payment_orders
					where paid_at >= (timezone('UTC', clock_timestamp()))::date - 29
					group by (timezone('UTC', paid_at))::date
				), dispensed as (
					select (timezone('UTC', dispensed_at))::date as day, count(*) as dispensed_resources
					from payment_orders
					where dispensed_at >= (timezone('UTC', clock_timestamp()))::date - 29
					group by (timezone('UTC', dispensed_at))::date
				)
				select days.day::text as day,
					coalesce(views.page_views, 0) as page_views,
					coalesce(quotes.quotes_issued, 0) as quotes_issued,
					coalesce(paid.paid_payments, 0) as paid_payments,
					coalesce(dispensed.dispensed_resources, 0) as dispensed_resources
				from days
				left join views using (day)
				left join quotes using (day)
				left join paid using (day)
				left join dispensed using (day)
				order by days.day
			`,
		]);
		const pageViews = pageViewRows[0];
		if (pageViews === undefined) throw new Error("Page view aggregates unavailable");
		const byProduct: Record<PaymentProduct, ProductStats> = {
			catch: emptyProductStats(),
			whisper: emptyProductStats(),
			pulse: emptyProductStats(),
		};
		for (const row of rows) {
			const planStats = mapPlanStats(row);
			byProduct[row.product].byPlan[row.plan_id] = planStats;
			byProduct[row.product].quotesIssued += planStats.quotesIssued;
			byProduct[row.product].paidPayments += planStats.paidPayments;
			byProduct[row.product].dispensedResources += planStats.dispensedResources;
			byProduct[row.product].receivedSats += planStats.receivedSats;
		}
		const totals = {
			pageViews: safeCounter(pageViews.page_views),
			quotesIssued: sumProducts(byProduct, "quotesIssued"),
			paidPayments: sumProducts(byProduct, "paidPayments"),
			dispensedResources: sumProducts(byProduct, "dispensedResources"),
		};
		return {
			pageViews: totals.pageViews,
			viewsToday: safeCounter(pageViews.views_today),
			viewsLast7Days: safeCounter(pageViews.views_last_7_days),
			quotesIssued: totals.quotesIssued,
			paidPayments: totals.paidPayments,
			dispensedResources: totals.dispensedResources,
			receivedSats: sumProducts(byProduct, "receivedSats"),
			funnel: {
				trackingStartedOn: asDay(pageViews.tracking_started_on),
				...totals,
				visitToQuotePercent: conversion(totals.quotesIssued, totals.pageViews),
				quoteToPaidPercent: conversion(totals.paidPayments, totals.quotesIssued),
				paidToDispensedPercent: conversion(totals.dispensedResources, totals.paidPayments),
			},
			activityLast30Days: activityRows.map((row) => ({ day: asDay(row.day) ?? "", pageViews: safeCounter(row.page_views), quotesIssued: safeCounter(row.quotes_issued), paidPayments: safeCounter(row.paid_payments), dispensedResources: safeCounter(row.dispensed_resources) })),
			byProduct,
		};
	}
}

function emptyPlanStats(): PlanStats { return { quotesIssued: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0 }; }
function emptyProductStats(): ProductStats { return { ...emptyPlanStats(), byPlan: { spark: emptyPlanStats(), standard: emptyPlanStats(), long: emptyPlanStats() } }; }
function mapPlanStats(row: StatsRow): PlanStats { return { quotesIssued: safeCounter(row.quotes_issued), paidPayments: safeCounter(row.paid_payments), dispensedResources: safeCounter(row.dispensed_resources), receivedSats: safeCounter(row.received_sats) }; }
function sumProducts(products: Record<PaymentProduct, ProductStats>, key: keyof PlanStats): number { return products.catch[key] + products.whisper[key] + products.pulse[key]; }
function conversion(numerator: number, denominator: number): number { return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1)); }
function asDay(value: string | Date | null): string | null { if (value === null) return null; return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10); }
function safeCounter(value: string): number { const counter = Number(value); if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Platform aggregate exceeds the public stats range"); return counter; }
