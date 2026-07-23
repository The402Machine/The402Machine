import type { Sql, TransactionSql } from "postgres";

import type { CatchPlanId } from "../domain/catch-plans.js";
import { transitionCatchResource, type CatchResourceStatus } from "../domain/catch-resource.js";

const ALLOWED_EVENT_HEADERS = new Set(["content-type", "user-agent", "x-request-id", "x-github-event", "x-github-delivery", "stripe-signature"]);
const EVENT_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export type CatchResource = {
	id: string;
	publicId: string;
	planId: CatchPlanId;
	status: CatchResourceStatus;
	ingestAuthRequired: boolean;
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
	method: string;
	authenticated: boolean;
	contentType: string;
	headers: Record<string, string>;
	body: Buffer;
	receivedAt: Date;
};

export type CatchEventAccess = "public" | "authenticated";
export type CatchEventListOptions = {
	limit: number;
	cursor?: number;
	access?: CatchEventAccess;
	method?: string;
	contentType?: string;
	query?: string;
};
export type CatchEventPage = { events: CatchEvent[]; nextCursor: number | null };

export type CatchCredentialHashes = {
	ownerTokenHash: string | null;
	ingestTokenHash: string | null;
	ingestAuthRequired: boolean;
};

type CredentialRow = {
	owner_token_hash: string | null;
	ingest_token_hash: string | null;
	ingest_auth_required: boolean;
};

type ResourceRow = {
	is_expired: boolean;
	id: string;
	public_id: string;
	plan_id: CatchPlanId;
	status: CatchResourceStatus;
	ingest_auth_required: boolean;
	request_limit: number;
	storage_limit_bytes: string;
	max_bytes_per_request: number;
	accepted_request_count: number;
	stored_bytes: string;
	created_at: Date;
	expires_at: Date;
};

type LockedResourceRow = ResourceRow & CredentialRow;

type EventRow = {
	id: string;
	sequence_number: number;
	method: string;
	authenticated: boolean;
	content_type: string;
	headers: Record<string, string>;
	body: Buffer;
	received_at: Date;
};

export type ProvisionInput = {
	publicId: string;
	planId: CatchPlanId;
	ownerTokenHash: string;
	ingestTokenHash: string;
	requestLimit: number;
	storageLimitBytes: number;
	maxBytesPerRequest: number;
	expiresAt: Date;
};

export type AcceptEventInput = {
	publicId: string;
	method?: string;
	authenticated?: boolean;
	contentType: string;
	headers: Record<string, string>;
	body: Buffer;
};

export type AcceptEventResult =
	| { accepted: true; eventId: string; sequenceNumber: number }
	| { accepted: false; reason: "not_found" | "expired" | "inactive" | "exhausted" | "body_too_large" | "unauthorized" };

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
			returning *, false as is_expired
		`;
		if (row === undefined) throw new Error("CATCH provisioning returned no resource");
		return mapResource(row);
	}

	public async getResource(publicId: string): Promise<CatchResource | null> {
		const [row] = await this.sql<ResourceRow[]>`
			select *, clock_timestamp() >= expires_at as is_expired from catch_resources where public_id = ${publicId}
		`;
		return row === undefined ? null : mapResource(row);
	}

	public async getCredentialHashes(publicId: string): Promise<CatchCredentialHashes | null> {
		return this.sql.begin(async (tx) => {
			const resource = await lockResource(tx, publicId);
			if (resource === undefined) return null;
			if (resource.is_expired) {
				await expireLockedResource(tx, resource);
				return null;
			}
			if (resource.status !== "active" && resource.status !== "exhausted" && resource.status !== "suspended") return null;
			return { ownerTokenHash: resource.owner_token_hash, ingestTokenHash: resource.ingest_token_hash, ingestAuthRequired: resource.ingest_auth_required };
		});
	}

	public async setIngestAuthRequired(publicId: string, required: boolean): Promise<boolean> {
		const rows = await this.sql<{ public_id: string }[]>`
			update catch_resources
			set ingest_auth_required = ${required}, updated_at = clock_timestamp()
			where public_id = ${publicId} and status in ('active', 'exhausted', 'suspended') and clock_timestamp() < expires_at
			returning public_id
		`;
		return rows[0] !== undefined;
	}

	public async acceptEvent(input: AcceptEventInput): Promise<AcceptEventResult> {
		assertAllowedHeaders(input.headers);
		const method = (input.method ?? "POST").toUpperCase();
		if (!EVENT_METHODS.has(method)) throw new Error("CATCH event method is invalid");
		const authenticated = input.authenticated ?? true;
		return this.sql.begin(async (tx) => {
			const [resource] = await tx<ResourceRow[]>`
				select *, clock_timestamp() >= expires_at as is_expired
				from catch_resources
				where public_id = ${input.publicId}
				for update
			`;
			if (resource === undefined) return { accepted: false, reason: "not_found" };
			if (resource.is_expired) {
				await expireLockedResource(tx, resource);
				return { accepted: false, reason: "expired" };
			}
			if (resource.status === "exhausted") return { accepted: false, reason: "exhausted" };
			if (resource.status !== "active") return { accepted: false, reason: "inactive" };
			if (resource.ingest_auth_required && !authenticated) return { accepted: false, reason: "unauthorized" };
			if (input.body.byteLength > resource.max_bytes_per_request) return { accepted: false, reason: "body_too_large" };

			const nextCount = resource.accepted_request_count + 1;
			const [eventSize] = await tx<{ bytes: number }[]>`select catch_event_stored_bytes(${tx.json(input.headers)}, ${input.body}) as bytes`;
			if (eventSize === undefined) throw new Error("CATCH event size could not be calculated");
			const nextBytes = Number(resource.stored_bytes) + eventSize.bytes;
			if (nextCount > resource.request_limit || nextBytes > Number(resource.storage_limit_bytes)) {
				await tx`update catch_resources set status = 'exhausted', exhausted_at = coalesce(exhausted_at, clock_timestamp()), updated_at = clock_timestamp() where id = ${resource.id}`;
				return { accepted: false, reason: "exhausted" };
			}

			const [event] = await tx<{ id: string }[]>`
				insert into catch_events (resource_id, sequence_number, method, authenticated, content_type, headers, body)
				values (${resource.id}, ${nextCount}, ${method}, ${authenticated}, ${input.contentType}, ${tx.json(input.headers)}, ${input.body})
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

	public async listEvents(publicId: string, options: CatchEventListOptions): Promise<CatchEventPage> {
		const limit = Math.max(1, Math.min(50, options.limit));
		const cursor = options.cursor === undefined ? null : Math.max(1, Math.floor(options.cursor));
		const access = options.access === "public" ? false : options.access === "authenticated" ? true : null;
		const method = typeof options.method === "string" && EVENT_METHODS.has(options.method.toUpperCase()) ? options.method.toUpperCase() : null;
		const contentType = typeof options.contentType === "string" && options.contentType.length > 0 ? options.contentType.slice(0, 120).toLowerCase() : null;
		const query = typeof options.query === "string" && options.query.trim().length > 0 ? options.query.trim().slice(0, 120) : null;
		return this.sql.begin(async (tx) => {
			const resource = await lockResource(tx, publicId);
			if (resource === undefined) return { events: [], nextCursor: null };
			if (resource.is_expired) {
				await expireLockedResource(tx, resource);
				return { events: [], nextCursor: null };
			}
			if (resource.status !== "active" && resource.status !== "exhausted" && resource.status !== "suspended") return { events: [], nextCursor: null };
			const rows = await tx<EventRow[]>`
				select id, sequence_number, method, authenticated, content_type, headers, body, received_at
				from catch_events
				where resource_id = ${resource.id}
					and (${cursor}::integer is null or sequence_number < ${cursor})
					and (${access}::boolean is null or authenticated = ${access})
					and (${method}::text is null or method = ${method})
					and (${contentType}::text is null or lower(content_type) = ${contentType})
					and (${query}::text is null or encode(body, 'escape') ilike ${query === null ? null : `%${query}%`})
				order by sequence_number desc
				limit ${limit + 1}
			`;
			const hasMore = rows.length > limit;
			const pageRows = rows.slice(0, limit);
			return { events: pageRows.map(mapEvent), nextCursor: hasMore ? pageRows[pageRows.length - 1]?.sequence_number ?? null : null };
		});
	}

	public async deleteEvent(publicId: string, eventId: string): Promise<boolean> {
		return this.sql.begin(async (tx) => {
			const [resource] = await tx<ResourceRow[]>`select *, false as is_expired from catch_resources where public_id = ${publicId} for update`;
			if (resource === undefined || !["active", "exhausted", "suspended"].includes(resource.status)) return false;
			const [deleted] = await tx<{ stored_bytes: number }[]>`
				delete from catch_events where id = ${eventId} and resource_id = ${resource.id}
				returning catch_event_stored_bytes(headers, body) as stored_bytes
			`;
			if (deleted === undefined) return false;
			await tx`update catch_resources set stored_bytes = greatest(0, stored_bytes - ${deleted.stored_bytes}), updated_at = clock_timestamp() where id = ${resource.id}`;
			return true;
		});
	}

	public async expireDueResources(requestedLimit = 100): Promise<number> {
		const limit = Math.max(1, Math.min(1_000, requestedLimit));
		return this.sql.begin(async (tx) => {
			const resources = await tx<{ id: string }[]>`
				select id from catch_resources
				where status in ('active', 'exhausted', 'suspended') and clock_timestamp() >= expires_at
				order by expires_at asc limit ${limit} for update skip locked
			`;
			if (resources.length === 0) return 0;
			const resourceIds = resources.map((resource) => resource.id);
			await tx`delete from catch_events where resource_id in ${tx(resourceIds)}`;
			const expired = await tx`
				update catch_resources
				set status = 'expired', expired_at = coalesce(expired_at, clock_timestamp()), owner_token_hash = null, ingest_token_hash = null, stored_bytes = 0, updated_at = clock_timestamp()
				where id in ${tx(resourceIds)}
			`;
			return expired.count;
		});
	}

	public async destroy(publicId: string): Promise<boolean> {
		return this.sql.begin(async (tx) => {
			const [resource] = await tx<ResourceRow[]>`select *, false as is_expired from catch_resources where public_id = ${publicId} for update`;
			if (resource === undefined || resource.status === "expired" || resource.status === "manually_destroyed" || resource.status === "deleted") return false;
			const nextStatus = transitionCatchResource(resource.status, resource.status === "active" ? "manually_destroyed" : "deleted");
			await tx`delete from catch_events where resource_id = ${resource.id}`;
			await tx`
				update catch_resources
				set status = ${nextStatus}::catch_resource_status,
					manually_destroyed_at = case when ${nextStatus === "manually_destroyed"} then clock_timestamp() else manually_destroyed_at end,
					deleted_at = case when ${nextStatus === "deleted"} then clock_timestamp() else deleted_at end,
					owner_token_hash = null, ingest_token_hash = null, stored_bytes = 0, updated_at = clock_timestamp()
				where id = ${resource.id}
			`;
			return true;
		});
	}
}

async function lockResource(tx: TransactionSql, publicId: string): Promise<LockedResourceRow | undefined> {
	const [resource] = await tx<LockedResourceRow[]>`select *, clock_timestamp() >= expires_at as is_expired from catch_resources where public_id = ${publicId} for update`;
	return resource;
}

async function expireLockedResource(tx: TransactionSql, resource: ResourceRow): Promise<void> {
	if (resource.status !== "active" && resource.status !== "exhausted" && resource.status !== "suspended") return;
	await tx`delete from catch_events where resource_id = ${resource.id}`;
	await tx`update catch_resources set status = 'expired', expired_at = coalesce(expired_at, clock_timestamp()), owner_token_hash = null, ingest_token_hash = null, stored_bytes = 0, updated_at = clock_timestamp() where id = ${resource.id}`;
}

function assertAllowedHeaders(headers: Record<string, string>): void {
	if (Object.entries(headers).some(([name, value]) => !ALLOWED_EVENT_HEADERS.has(name) || typeof value !== "string")) throw new Error("CATCH event headers are invalid");
}

function mapResource(row: ResourceRow): CatchResource {
	return {
		id: row.id,
		publicId: row.public_id,
		planId: row.plan_id,
		status: row.status,
		ingestAuthRequired: row.ingest_auth_required,
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
	return { id: row.id, sequenceNumber: row.sequence_number, method: row.method, authenticated: row.authenticated, contentType: row.content_type, headers: row.headers, body: row.body, receivedAt: row.received_at };
}
