import type { Sql } from "postgres";

import type { CatchPlanId } from "../domain/catch-plans.js";
import type { CatchResourceStatus } from "../domain/catch-resource.js";

export type CatchResource = {
	id: string;
	publicId: string;
	planId: CatchPlanId;
	status: CatchResourceStatus;
	requestLimit: number;
	storageLimitBytes: number;
	maxBytesPerRequest: number;
	acceptedRequestCount: number;
	storedBytes: number;
	createdAt: Date;
	expiresAt: Date;
};

export type CatchEvent = {
	id: string;
	sequenceNumber: number;
	contentType: string;
	headers: Record<string, string>;
	body: Buffer;
	receivedAt: Date;
};

type ResourceRow = {
	id: string;
	public_id: string;
	plan_id: CatchPlanId;
	status: CatchResourceStatus;
	request_limit: number;
	storage_limit_bytes: string;
	max_bytes_per_request: number;
	accepted_request_count: number;
	stored_bytes: string;
	created_at: Date;
	expires_at: Date;
};

type EventRow = {
	id: string;
	sequence_number: number;
	content_type: string;
	headers: Record<string, string>;
	body: Buffer;
	received_at: Date;
};

type ProvisionInput = {
	publicId: string;
	planId: CatchPlanId;
	ownerTokenHash: string;
	ingestTokenHash: string;
	requestLimit: number;
	storageLimitBytes: number;
	maxBytesPerRequest: number;
	expiresAt: Date;
};

type AcceptEventInput = {
	publicId: string;
	contentType: string;
	headers: Record<string, string>;
	body: Buffer;
};

export type AcceptEventResult =
	| { accepted: true; eventId: string; sequenceNumber: number }
	| { accepted: false; reason: "not_found" | "expired" | "inactive" | "exhausted" | "body_too_large" };

export class CatchRepository {
	public constructor(private readonly sql: Sql) {}

	public async provision(input: ProvisionInput): Promise<CatchResource> {
		const [row] = await this.sql<ResourceRow[]>`
			insert into catch_resources (
				public_id, plan_id, owner_token_hash, ingest_token_hash,
				request_limit, storage_limit_bytes, max_bytes_per_request, expires_at
			) values (
				${input.publicId}, ${input.planId}, ${input.ownerTokenHash}, ${input.ingestTokenHash},
				${input.requestLimit}, ${input.storageLimitBytes}, ${input.maxBytesPerRequest}, ${input.expiresAt}
			)
			returning *
		`;
		if (row === undefined) throw new Error("CATCH provisioning returned no resource");
		return mapResource(row);
	}

	public async getResource(publicId: string): Promise<CatchResource | null> {
		const [row] = await this.sql<ResourceRow[]>`
			select * from catch_resources where public_id = ${publicId}
		`;
		return row === undefined ? null : mapResource(row);
	}

	public async acceptEvent(input: AcceptEventInput): Promise<AcceptEventResult> {
		return this.sql.begin(async (tx) => {
			const [resource] = await tx<ResourceRow[]>`
				select * from catch_resources where public_id = ${input.publicId} for update
			`;
			if (resource === undefined) return { accepted: false, reason: "not_found" };

			const now = new Date();
			if (now.getTime() >= resource.expires_at.getTime()) {
				if (resource.status === "active" || resource.status === "exhausted" || resource.status === "suspended") {
					await tx`
						update catch_resources
						set status = 'expired', expired_at = coalesce(expired_at, clock_timestamp()),
							owner_token_hash = null, ingest_token_hash = null, updated_at = clock_timestamp()
						where id = ${resource.id}
					`;
				}
				return { accepted: false, reason: "expired" };
			}
			if (resource.status === "exhausted") return { accepted: false, reason: "exhausted" };
			if (resource.status !== "active") return { accepted: false, reason: "inactive" };
			if (input.body.byteLength > resource.max_bytes_per_request) return { accepted: false, reason: "body_too_large" };

			const nextCount = resource.accepted_request_count + 1;
			const nextBytes = Number(resource.stored_bytes) + input.body.byteLength;
			if (nextCount > resource.request_limit || nextBytes > Number(resource.storage_limit_bytes)) {
				await tx`
					update catch_resources
					set status = 'exhausted', exhausted_at = coalesce(exhausted_at, clock_timestamp()), updated_at = clock_timestamp()
					where id = ${resource.id}
				`;
				return { accepted: false, reason: "exhausted" };
			}

			const [event] = await tx<{ id: string }[]>`
				insert into catch_events (resource_id, sequence_number, content_type, headers, body)
				values (${resource.id}, ${nextCount}, ${input.contentType}, ${tx.json(input.headers)}, ${input.body})
				returning id
			`;
			if (event === undefined) throw new Error("CATCH event insertion returned no event");

			const exhausted = nextCount >= resource.request_limit || nextBytes >= Number(resource.storage_limit_bytes);
			await tx`
				update catch_resources
				set accepted_request_count = ${nextCount}, stored_bytes = ${nextBytes},
					status = ${exhausted ? "exhausted" : "active"}::catch_resource_status,
					exhausted_at = case when ${exhausted} then coalesce(exhausted_at, clock_timestamp()) else exhausted_at end,
					updated_at = clock_timestamp()
				where id = ${resource.id}
			`;
			return { accepted: true, eventId: event.id, sequenceNumber: nextCount };
		});
	}

	public async listEvents(publicId: string, requestedLimit: number): Promise<CatchEvent[]> {
		const limit = Math.max(1, Math.min(50, requestedLimit));
		const rows = await this.sql<EventRow[]>`
			select e.id, e.sequence_number, e.content_type, e.headers, e.body, e.received_at
			from catch_events e
			join catch_resources r on r.id = e.resource_id
			where r.public_id = ${publicId}
				and r.status in ('active', 'exhausted', 'suspended')
				and clock_timestamp() < r.expires_at
			order by e.sequence_number desc
			limit ${limit}
		`;
		return rows.map(mapEvent);
	}

	public async deleteEvent(publicId: string, eventId: string): Promise<boolean> {
		return this.sql.begin(async (tx) => {
			const [resource] = await tx<ResourceRow[]>`
				select * from catch_resources where public_id = ${publicId} for update
			`;
			if (resource === undefined || !["active", "exhausted", "suspended"].includes(resource.status)) return false;
			const [deleted] = await tx<{ body_bytes: number }[]>`
				delete from catch_events where id = ${eventId} and resource_id = ${resource.id} returning body_bytes
			`;
			if (deleted === undefined) return false;
			await tx`
				update catch_resources
				set stored_bytes = greatest(0, stored_bytes - ${deleted.body_bytes}), updated_at = clock_timestamp()
				where id = ${resource.id}
			`;
			return true;
		});
	}

	public async destroy(publicId: string): Promise<boolean> {
		return this.sql.begin(async (tx) => {
			const [resource] = await tx<ResourceRow[]>`
				select * from catch_resources where public_id = ${publicId} for update
			`;
			if (resource === undefined || resource.status === "deleted" || resource.status === "expired" || resource.status === "manually_destroyed") return false;
			await tx`delete from catch_events where resource_id = ${resource.id}`;
			await tx`
				update catch_resources
				set status = 'manually_destroyed', manually_destroyed_at = clock_timestamp(),
					owner_token_hash = null, ingest_token_hash = null, stored_bytes = 0, updated_at = clock_timestamp()
				where id = ${resource.id}
			`;
			return true;
		});
	}
}

function mapResource(row: ResourceRow): CatchResource {
	return {
		id: row.id,
		publicId: row.public_id,
		planId: row.plan_id,
		status: row.status,
		requestLimit: row.request_limit,
		storageLimitBytes: Number(row.storage_limit_bytes),
		maxBytesPerRequest: row.max_bytes_per_request,
		acceptedRequestCount: row.accepted_request_count,
		storedBytes: Number(row.stored_bytes),
		createdAt: row.created_at,
		expiresAt: row.expires_at,
	};
}

function mapEvent(row: EventRow): CatchEvent {
	return {
		id: row.id,
		sequenceNumber: row.sequence_number,
		contentType: row.content_type,
		headers: row.headers,
		body: row.body,
		receivedAt: row.received_at,
	};
}
