import type { Sql } from "postgres";

import type { CatchPlanId } from "../domain/catch-plans.js";

export type PulseStatus = "active" | "exhausted" | "expired" | "manually_destroyed";
export type PulseResource = {
	id: string; publicId: string; planId: CatchPlanId; status: PulseStatus;
	ownerTokenHash: string | null; pingTokenHash: string | null;
	heartbeatLimit: number; heartbeatCount: number; expectedIntervalSeconds: number; graceSeconds: number;
	name: string; description: string; publicStatusEnabled: boolean; lastPingAt: Date | null;
	createdAt: Date; expiresAt: Date;
};
export type CreatePulseInput = {
	publicId: string; planId: CatchPlanId; ownerTokenHash: string; pingTokenHash: string; heartbeatLimit: number;
	expectedIntervalSeconds: number; graceSeconds: number; expiresAt: Date;
};
export type PulseSettings = { name: string; description: string; expectedIntervalSeconds: number; graceSeconds: number; publicStatusEnabled: boolean };
export type AcceptPulseResult = { accepted: true; heartbeatCount: number; lastPingAt: Date; exhausted: boolean } | { accepted: false; reason: "not_found" | "expired" | "exhausted" };

type Row = {
	id: string; public_id: string; plan_id: CatchPlanId; status: PulseStatus; owner_token_hash: string | null; ping_token_hash: string | null;
	heartbeat_limit: number; heartbeat_count: number; expected_interval_seconds: number; grace_seconds: number; name: string; description: string;
	public_status_enabled: boolean; last_ping_at: Date | null; created_at: Date; expires_at: Date;
};

export class PulseRepository {
	public constructor(private readonly sql: Sql) {}

	public async create(input: CreatePulseInput): Promise<PulseResource> {
		const rows = await this.sql<Row[]>`
			insert into pulse_resources (public_id, plan_id, owner_token_hash, ping_token_hash, heartbeat_limit, expected_interval_seconds, grace_seconds, expires_at)
			values (${input.publicId}, ${input.planId}, ${input.ownerTokenHash}, ${input.pingTokenHash}, ${input.heartbeatLimit}, ${input.expectedIntervalSeconds}, ${input.graceSeconds}, ${input.expiresAt}) returning *
		`;
		if (rows[0] === undefined) throw new Error("PULSE creation returned no resource");
		return mapRow(rows[0]);
	}

	public async getResource(publicId: string): Promise<PulseResource | null> {
		const rows = await this.sql<Row[]>`select * from pulse_resources where public_id = ${publicId}`;
		return rows[0] === undefined ? null : mapRow(rows[0]);
	}

	public async getCredentialHashes(publicId: string): Promise<{ ownerTokenHash: string | null; pingTokenHash: string | null } | null> {
		const rows = await this.sql<{ owner_token_hash: string | null; ping_token_hash: string | null }[]>`select owner_token_hash, ping_token_hash from pulse_resources where public_id = ${publicId}`;
		return rows[0] === undefined ? null : { ownerTokenHash: rows[0].owner_token_hash, pingTokenHash: rows[0].ping_token_hash };
	}

	public async acceptHeartbeat(publicId: string): Promise<AcceptPulseResult> {
		return this.sql.begin(async (tx) => {
			const rows = await tx<{ id: string; status: PulseStatus; heartbeat_count: number; heartbeat_limit: number; expires_at: Date; is_expired: boolean }[]>`
				select id, status, heartbeat_count, heartbeat_limit, expires_at, clock_timestamp() >= expires_at as is_expired from pulse_resources where public_id = ${publicId} for update
			`;
			const row = rows[0];
			if (row === undefined) return { accepted: false, reason: "not_found" };
			if (row.is_expired && (row.status === "active" || row.status === "exhausted")) {
				await tx`update pulse_resources set status = 'expired', owner_token_hash = null, ping_token_hash = null, name = 'Expired monitor', description = '', public_status_enabled = false, last_ping_at = null, expired_at = clock_timestamp(), updated_at = clock_timestamp() where id = ${row.id}`;
				return { accepted: false, reason: "expired" };
			}
			if (row.status !== "active") return { accepted: false, reason: row.status === "exhausted" ? "exhausted" : "not_found" };
			const exhausted = row.heartbeat_count + 1 >= row.heartbeat_limit;
			const updated = exhausted
				? await tx<{ heartbeat_count: number; last_ping_at: Date }[]>`
					update pulse_resources set heartbeat_count = heartbeat_count + 1, last_ping_at = clock_timestamp(), status = 'exhausted',
						ping_token_hash = null, exhausted_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = ${row.id} returning heartbeat_count, last_ping_at
				`
				: await tx<{ heartbeat_count: number; last_ping_at: Date }[]>`
					update pulse_resources set heartbeat_count = heartbeat_count + 1, last_ping_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = ${row.id} returning heartbeat_count, last_ping_at
				`;
			const result = updated[0];
			if (result === undefined) throw new Error("PULSE heartbeat update returned no resource");
			return { accepted: true, heartbeatCount: result.heartbeat_count, lastPingAt: result.last_ping_at, exhausted };
		});
	}

	public async updateSettings(publicId: string, settings: PulseSettings): Promise<PulseResource | null> {
		const rows = await this.sql<Row[]>`
			update pulse_resources set name = ${settings.name}, description = ${settings.description}, expected_interval_seconds = ${settings.expectedIntervalSeconds},
				grace_seconds = ${settings.graceSeconds}, public_status_enabled = ${settings.publicStatusEnabled}, updated_at = clock_timestamp()
			where public_id = ${publicId} and status in ('active', 'exhausted') returning *
		`;
		return rows[0] === undefined ? null : mapRow(rows[0]);
	}

	public async destroy(publicId: string): Promise<boolean> {
		const result = await this.sql`update pulse_resources set status = 'manually_destroyed', owner_token_hash = null, ping_token_hash = null, destroyed_at = clock_timestamp(), updated_at = clock_timestamp() where public_id = ${publicId} and status in ('active', 'exhausted')`;
		return result.count === 1;
	}

	public async expireDue(requestedLimit = 100): Promise<number> {
		const limit = Math.max(1, Math.min(1_000, requestedLimit));
		return this.sql.begin(async (tx) => {
			const rows = await tx<{ id: string }[]>`select id from pulse_resources where status in ('active', 'exhausted') and clock_timestamp() >= expires_at order by expires_at limit ${limit} for update skip locked`;
			if (rows.length === 0) return 0;
			const result = await tx`update pulse_resources set status = 'expired', owner_token_hash = null, ping_token_hash = null, name = 'Expired monitor', description = '', public_status_enabled = false, last_ping_at = null, expired_at = clock_timestamp(), updated_at = clock_timestamp() where id in ${tx(rows.map(({ id }) => id))}`;
			return result.count;
		});
	}
}

function mapRow(row: Row): PulseResource {
	return { id: row.id, publicId: row.public_id, planId: row.plan_id, status: row.status, ownerTokenHash: row.owner_token_hash, pingTokenHash: row.ping_token_hash, heartbeatLimit: row.heartbeat_limit, heartbeatCount: row.heartbeat_count, expectedIntervalSeconds: row.expected_interval_seconds, graceSeconds: row.grace_seconds, name: row.name, description: row.description, publicStatusEnabled: row.public_status_enabled, lastPingAt: row.last_ping_at, createdAt: row.created_at, expiresAt: row.expires_at };
}
