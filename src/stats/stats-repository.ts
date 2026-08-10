import type { Sql } from "postgres";

import type { PaymentProduct } from "../payment/payment-domain.js";

export type ProductStats = {
	paidPayments: number;
	dispensedResources: number;
	receivedSats: number;
};

export type PlatformStats = {
	paidPayments: number;
	dispensedResources: number;
	receivedSats: number;
	byProduct: Record<PaymentProduct, ProductStats>;
};

type StatsRow = {
	product: PaymentProduct;
	paid_payments: string;
	dispensed_resources: string;
	received_sats: string;
};

export class StatsRepository {
	public constructor(private readonly sql: Sql) {}

	public async getPublicStats(): Promise<PlatformStats> {
		const rows = await this.sql<StatsRow[]>`
			select
				product,
				count(*) filter (where event_type = 'payment_paid') as paid_payments,
				count(*) filter (where event_type = 'resource_dispensed') as dispensed_resources,
				coalesce(sum(amount_sats) filter (where event_type = 'payment_paid'), 0) as received_sats
			from platform_events
			group by product
		`;
		const byProduct: Record<PaymentProduct, ProductStats> = {
			catch: emptyProductStats(),
			whisper: emptyProductStats(),
			pulse: emptyProductStats(),
		};
		for (const row of rows) {
			byProduct[row.product] = {
				paidPayments: safeCounter(row.paid_payments),
				dispensedResources: safeCounter(row.dispensed_resources),
				receivedSats: safeCounter(row.received_sats),
			};
		}
		return {
			paidPayments: sumProducts(byProduct, "paidPayments"),
			dispensedResources: sumProducts(byProduct, "dispensedResources"),
			receivedSats: sumProducts(byProduct, "receivedSats"),
			byProduct,
		};
	}
}

function emptyProductStats(): ProductStats {
	return { paidPayments: 0, dispensedResources: 0, receivedSats: 0 };
}

function sumProducts(products: Record<PaymentProduct, ProductStats>, key: keyof ProductStats): number {
	return products.catch[key] + products.whisper[key] + products.pulse[key];
}

function safeCounter(value: string): number {
	const counter = Number(value);
	if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Platform aggregate exceeds the public stats range");
	return counter;
}
