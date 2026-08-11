import type { Sql, TransactionSql } from "postgres";

import { GATE_PACKS, gateMonthKey, type GateMethod, type GatePackId } from "./gate-domain.js";

const GATE_SETTLEMENT_GRACE_MINUTES = 5;

type ProjectRow = { id: string; public_id: string; display_name: string; lightning_address: string; monthly_free_limit: number; active: boolean; created_at: Date; updated_at: Date };
type RouteRow = { id: string; project_id: string; route_key: string; method: GateMethod; path: string; price_sats: number; active: boolean; created_at: Date; updated_at: Date };
type IntentState = "pending_invoice" | "invoice_issuing" | "invoice_issued" | "invoice_uncertain" | "paid" | "authorized" | "expired" | "failed";
type IntentRow = { id: string; public_id: string; project_id: string; route_id: string; idempotency_key: string; method: GateMethod; path: string; body_digest: string; amount_sats: number; lightning_address: string; state: IntentState; bolt11: string | null; payment_hash: string | null; verify_url: string | null; receipt: string | null; invoice_expires_at: Date | null; paid_at: Date | null; authorized_at: Date | null; created_at: Date; updated_at: Date };
type GrantRow = { id: string; project_id: string; source_order_id: string; pack_id: GatePackId; total_authorizations: number; remaining_authorizations: number; purchased_at: Date; expires_at: Date; created_at: Date };
type AuthorizationRow = { id: string; intent_id: string; receipt_jti: string; source: "monthly_free" | "prepaid_grant"; source_month: Date | null; grant_id: string | null; project_id: string; receipt: string; consumed_at: Date; created_at: Date };

export type GateProject = { id: string; publicId: string; displayName: string; lightningAddress: string; monthlyFreeLimit: number; active: boolean; createdAt: Date; updatedAt: Date };
export type GateRoute = { id: string; projectId: string; routeKey: string; method: GateMethod; path: string; priceSats: number; active: boolean; createdAt: Date; updatedAt: Date };
export type GateIntent = { id: string; publicId: string; projectId: string; routeId: string; idempotencyKey: string; method: GateMethod; path: string; bodyDigest: string; amountSats: number; lightningAddress: string; state: IntentState; bolt11: string | null; paymentHash: string | null; verifyUrl: string | null; receipt: string | null; invoiceExpiresAt: Date | null; paidAt: Date | null; authorizedAt: Date | null; createdAt: Date; updatedAt: Date };
export type GateCreditGrant = { id: string; projectId: string; sourceOrderId: string; packId: GatePackId; totalAuthorizations: number; remainingAuthorizations: number; purchasedAt: Date; expiresAt: Date; createdAt: Date };
export type GateAuthorization = { id: string; intentId: string; receiptJti: string; receipt: string; source: "monthly_free" | "prepaid_grant"; sourceMonth: Date | null; grantId: string | null; consumedAt: Date; createdAt: Date };

export class GateRepository {
	public constructor(private readonly sql: Sql) {}

	public async createProject(input: { publicId: string; displayName: string; lightningAddress: string; adminTokenHash: string; apiTokenHash: string }): Promise<GateProject> {
		const rows = await this.sql<ProjectRow[]>`
			insert into gate_projects (public_id, display_name, lightning_address, admin_token_hash, api_token_hash)
			values (${input.publicId}, ${input.displayName}, ${input.lightningAddress}, ${input.adminTokenHash}, ${input.apiTokenHash})
			returning id, public_id, display_name, lightning_address, monthly_free_limit, active, created_at, updated_at
		`;
		if (rows[0] === undefined) throw new Error("GATE project creation returned no project");
		return mapProject(rows[0]);
	}

	public async provisionProject(input: { publicId: string; displayName: string; lightningAddress: string; adminTokenHash: string; apiTokenHash: string; routes: Array<{ key: string; method: GateMethod; path: string; priceSats: number }> }): Promise<{ project: GateProject; routes: GateRoute[] }> {
		return this.sql.begin(async (tx) => {
			const projects = await tx<ProjectRow[]>`
				insert into gate_projects (public_id, display_name, lightning_address, admin_token_hash, api_token_hash)
				values (${input.publicId}, ${input.displayName}, ${input.lightningAddress}, ${input.adminTokenHash}, ${input.apiTokenHash})
				returning id, public_id, display_name, lightning_address, monthly_free_limit, active, created_at, updated_at
			`;
			const projectRow = projects[0];
			if (projectRow === undefined) throw new Error("GATE project creation returned no project");
			const routes: GateRoute[] = [];
			for (const route of input.routes) {
				const rows = await tx<RouteRow[]>`
					insert into gate_routes (project_id, route_key, method, path, price_sats)
					values (${projectRow.id}, ${route.key}, ${route.method}, ${route.path}, ${route.priceSats}) returning *
				`;
				if (rows[0] === undefined) throw new Error("GATE route creation returned no route");
				routes.push(mapRoute(rows[0]));
			}
			return { project: mapProject(projectRow), routes };
		});
	}

	public async authenticateProjectApi(publicId: string, apiTokenHash: string): Promise<GateProject | null> {
		const rows = await this.sql<ProjectRow[]>`
			select id, public_id, display_name, lightning_address, monthly_free_limit, active, created_at, updated_at
			from gate_projects where public_id = ${publicId} and api_token_hash = ${apiTokenHash} and active = true
		`;
		return rows[0] === undefined ? null : mapProject(rows[0]);
	}

	public async getProjectByPublicId(publicId: string): Promise<GateProject | null> {
		const rows = await this.sql<ProjectRow[]>`
			select id, public_id, display_name, lightning_address, monthly_free_limit, active, created_at, updated_at
			from gate_projects where public_id = ${publicId}
		`;
		return rows[0] === undefined ? null : mapProject(rows[0]);
	}

	public async createRoute(input: { projectId: string; routeKey: string; method: GateMethod; path: string; priceSats: number }): Promise<GateRoute> {
		const rows = await this.sql<RouteRow[]>`
			insert into gate_routes (project_id, route_key, method, path, price_sats)
			values (${input.projectId}, ${input.routeKey}, ${input.method}, ${input.path}, ${input.priceSats})
			returning *
		`;
		if (rows[0] === undefined) throw new Error("GATE route creation returned no route");
		return mapRoute(rows[0]);
	}

	public async getRouteForProject(projectId: string, routeKey: string): Promise<GateRoute | null> {
		const rows = await this.sql<RouteRow[]>`select * from gate_routes where project_id = ${projectId} and route_key = ${routeKey} and active = true`;
		return rows[0] === undefined ? null : mapRoute(rows[0]);
	}

	public async listRoutesForProject(projectId: string): Promise<GateRoute[]> {
		const rows = await this.sql<RouteRow[]>`select * from gate_routes where project_id = ${projectId} and active = true order by route_key`;
		return rows.map(mapRoute);
	}

	public async createIntent(input: { publicId: string; projectId: string; routeId: string; idempotencyKey: string; method: GateMethod; path: string; bodyDigest: string; amountSats: number; lightningAddress: string }): Promise<GateIntent> {
		const rows = await this.sql<IntentRow[]>`
			insert into gate_intents (public_id, project_id, route_id, idempotency_key, method, path, body_digest, amount_sats, lightning_address)
			values (${input.publicId}, ${input.projectId}, ${input.routeId}, ${input.idempotencyKey}, ${input.method}, ${input.path}, ${input.bodyDigest}, ${input.amountSats}, ${input.lightningAddress})
			on conflict (project_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
			returning *
		`;
		const row = rows[0];
		if (row === undefined) throw new Error("GATE intent creation returned no intent");
		if (row.route_id !== input.routeId || row.method !== input.method || row.path !== input.path || row.body_digest !== input.bodyDigest || row.amount_sats !== input.amountSats || row.lightning_address !== input.lightningAddress) throw new Error("GATE idempotency key already belongs to another request");
		return mapIntent(row);
	}

	public async claimInvoiceIssuance(intentId: string): Promise<GateIntent | null> {
		const rows = await this.sql<IntentRow[]>`
			update gate_intents set state = 'invoice_issuing', updated_at = clock_timestamp()
			where id = ${intentId} and state = 'pending_invoice' returning *
		`;
		return rows[0] === undefined ? null : mapIntent(rows[0]);
	}

	public async attachInvoice(intentId: string, invoice: { bolt11: string; paymentHash: string; expiresAt: Date; verifyUrl: string | null }): Promise<GateIntent> {
		const rows = await this.sql<IntentRow[]>`
			update gate_intents set state = 'invoice_issued', bolt11 = ${invoice.bolt11}, payment_hash = ${invoice.paymentHash}, invoice_expires_at = ${invoice.expiresAt}, verify_url = ${invoice.verifyUrl}, updated_at = clock_timestamp()
			where id = ${intentId} and state = 'invoice_issuing' returning *
		`;
		if (rows[0] === undefined) throw new Error("GATE intent is not issuing an invoice");
		return mapIntent(rows[0]);
	}

	public async markInvoiceUncertain(intentId: string): Promise<GateIntent> {
		const rows = await this.sql<IntentRow[]>`update gate_intents set state = 'invoice_uncertain', updated_at = clock_timestamp() where id = ${intentId} and state = 'invoice_issuing' returning *`;
		if (rows[0] === undefined) throw new Error("GATE intent is not awaiting an invoice");
		return mapIntent(rows[0]);
	}

	public async getIntent(intentId: string): Promise<GateIntent | null> {
		const rows = await this.sql<IntentRow[]>`select * from gate_intents where id = ${intentId}`;
		return rows[0] === undefined ? null : mapIntent(rows[0]);
	}

	public async getIntentForProject(intentId: string, projectId: string): Promise<GateIntent | null> {
		const rows = await this.sql<IntentRow[]>`select * from gate_intents where id = ${intentId} and project_id = ${projectId}`;
		return rows[0] === undefined ? null : mapIntent(rows[0]);
	}

	public async markPaid(intentId: string, paidAt: Date): Promise<GateIntent | null> {
		const rows = await this.sql<IntentRow[]>`
			update gate_intents set state = 'paid', paid_at = ${paidAt}, updated_at = clock_timestamp()
			where id = ${intentId}
				and state in ('invoice_issued', 'expired')
				and invoice_expires_at is not null
				and ${paidAt} <= invoice_expires_at + (${GATE_SETTLEMENT_GRACE_MINUTES} * interval '1 minute')
			returning *
		`;
		if (rows[0] !== undefined) return mapIntent(rows[0]);
		const current = await this.getIntent(intentId);
		return current?.state === "paid" || current?.state === "authorized" ? current : null;
	}

	public async addCreditGrant(input: { projectId: string; sourceOrderId: string; packId: GatePackId; purchasedAt: Date; expiresAt: Date }): Promise<GateCreditGrant> {
		const count = GATE_PACKS[input.packId].authorizations;
		const rows = await this.sql<GrantRow[]>`
			insert into gate_credit_grants (project_id, source_order_id, pack_id, total_authorizations, remaining_authorizations, purchased_at, expires_at)
			values (${input.projectId}, ${input.sourceOrderId}, ${input.packId}, ${count}, ${count}, ${input.purchasedAt}, ${input.expiresAt}) returning *
		`;
		if (rows[0] === undefined) throw new Error("GATE credit grant creation returned no grant");
		return mapGrant(rows[0]);
	}

	public async getCreditGrant(grantId: string): Promise<GateCreditGrant | null> {
		const rows = await this.sql<GrantRow[]>`select * from gate_credit_grants where id = ${grantId}`;
		return rows[0] === undefined ? null : mapGrant(rows[0]);
	}

	public async getAuthorization(intentId: string): Promise<GateAuthorization | null> {
		const rows = await this.sql<AuthorizationRow[]>`select a.*, i.receipt from gate_authorizations a join gate_intents i on i.id = a.intent_id where a.intent_id = ${intentId}`;
		return rows[0] === undefined ? null : mapAuthorization(rows[0]);
	}

	public async expireDueIntents(limit: number, now = new Date()): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("GATE expiry limit must be between 1 and 1000");
		const rows = await this.sql<{ id: string }[]>`
			with due as (
				select id from gate_intents
				where state = 'invoice_issued' and invoice_expires_at <= ${now}
				order by invoice_expires_at, id
				for update skip locked
				limit ${limit}
			)
			update gate_intents set state = 'expired', updated_at = clock_timestamp()
			where id in (select id from due)
			returning id
		`;
		return rows.length;
	}

	public async authorizeIntent(input: { intentId: string; receiptJti: string; now: Date; createReceipt(receiptJti: string, projectPublicId: string): string }): Promise<GateAuthorization> {
		return this.sql.begin(async (tx) => {
			const intents = await tx<IntentRow[]>`select * from gate_intents where id = ${input.intentId} for update`;
			const intent = intents[0];
			if (intent === undefined) throw new Error("GATE intent not found");
			const existing = await authorizationForIntent(tx, intent.id);
			if (existing !== null) return existing;
			if (intent.state !== "paid") throw new Error("GATE intent is not ready for authorization");
			if (intent.invoice_expires_at === null || intent.paid_at === null || intent.paid_at.getTime() > intent.invoice_expires_at.getTime() + GATE_SETTLEMENT_GRACE_MINUTES * 60_000) throw new Error("GATE payment proof exceeded settlement grace");

			const projects = await tx<{ public_id: string; monthly_free_limit: number }[]>`select public_id, monthly_free_limit from gate_projects where id = ${intent.project_id} for update`;
			const project = projects[0];
			if (project === undefined) throw new Error("GATE project not found");
			const sourceMonth = new Date(`${gateMonthKey(input.now)}-01T00:00:00.000Z`);
			const [usage] = await tx<{ count: number }[]>`select count(*)::int as count from gate_authorizations where project_id = ${intent.project_id} and source = 'monthly_free' and source_month = ${sourceMonth}`;

			let source: GateAuthorization["source"] = "monthly_free";
			let grantId: string | null = null;
			if ((usage?.count ?? 0) >= project.monthly_free_limit) {
				const grants = await tx<GrantRow[]>`
					select * from gate_credit_grants
					where project_id = ${intent.project_id} and remaining_authorizations > 0 and expires_at > ${input.now}
					order by expires_at, purchased_at, id for update skip locked limit 1
				`;
				const grant = grants[0];
				if (grant === undefined) throw new Error("No GATE authorizations available");
				const updated = await tx<GrantRow[]>`update gate_credit_grants set remaining_authorizations = remaining_authorizations - 1 where id = ${grant.id} and remaining_authorizations > 0 returning *`;
				if (updated[0] === undefined) throw new Error("No GATE authorizations available");
				source = "prepaid_grant";
				grantId = grant.id;
			}

			const paidAt = intent.paid_at ?? input.now;
			const receipt = input.createReceipt(input.receiptJti, project.public_id);
			if (receipt.length < 64 || receipt.length > 8_192) throw new Error("GATE receipt is invalid");
			await tx`update gate_intents set state = 'authorized', paid_at = ${paidAt}, authorized_at = ${input.now}, receipt = ${receipt}, updated_at = clock_timestamp() where id = ${intent.id}`;
			const rows = source === "monthly_free"
				? await tx<AuthorizationRow[]>`insert into gate_authorizations (intent_id, receipt_jti, source, source_month, project_id) values (${intent.id}, ${input.receiptJti}, 'monthly_free', ${sourceMonth}, ${intent.project_id}) returning *, ${receipt}::text as receipt`
				: await tx<AuthorizationRow[]>`insert into gate_authorizations (intent_id, receipt_jti, source, grant_id, project_id) values (${intent.id}, ${input.receiptJti}, 'prepaid_grant', ${grantId}, ${intent.project_id}) returning *, ${receipt}::text as receipt`;
			if (rows[0] === undefined) throw new Error("GATE authorization creation returned no authorization");
			return mapAuthorization(rows[0]);
		});
	}
}

async function authorizationForIntent(tx: TransactionSql, intentId: string): Promise<GateAuthorization | null> {
	const rows = await tx<AuthorizationRow[]>`select a.*, i.receipt from gate_authorizations a join gate_intents i on i.id = a.intent_id where a.intent_id = ${intentId}`;
	return rows[0] === undefined ? null : mapAuthorization(rows[0]);
}

function mapProject(row: ProjectRow): GateProject { return { id: row.id, publicId: row.public_id, displayName: row.display_name, lightningAddress: row.lightning_address, monthlyFreeLimit: row.monthly_free_limit, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapRoute(row: RouteRow): GateRoute { return { id: row.id, projectId: row.project_id, routeKey: row.route_key, method: row.method, path: row.path, priceSats: row.price_sats, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapIntent(row: IntentRow): GateIntent { return { id: row.id, publicId: row.public_id, projectId: row.project_id, routeId: row.route_id, idempotencyKey: row.idempotency_key, method: row.method, path: row.path, bodyDigest: row.body_digest, amountSats: row.amount_sats, lightningAddress: row.lightning_address, state: row.state, bolt11: row.bolt11, paymentHash: row.payment_hash, verifyUrl: row.verify_url, receipt: row.receipt, invoiceExpiresAt: row.invoice_expires_at, paidAt: row.paid_at, authorizedAt: row.authorized_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapGrant(row: GrantRow): GateCreditGrant { return { id: row.id, projectId: row.project_id, sourceOrderId: row.source_order_id, packId: row.pack_id, totalAuthorizations: row.total_authorizations, remainingAuthorizations: row.remaining_authorizations, purchasedAt: row.purchased_at, expiresAt: row.expires_at, createdAt: row.created_at }; }
function mapAuthorization(row: AuthorizationRow): GateAuthorization { return { id: row.id, intentId: row.intent_id, receiptJti: row.receipt_jti, receipt: row.receipt, source: row.source, sourceMonth: row.source_month, grantId: row.grant_id, consumedAt: row.consumed_at, createdAt: row.created_at }; }
