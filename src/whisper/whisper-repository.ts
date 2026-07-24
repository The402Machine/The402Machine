import type { Sql } from "postgres";

import type { CatchPlanId } from "../domain/catch-plans.js";

export type CreateWhisperInput = {
	publicId: string;
	planId: CatchPlanId;
	readTokenHash: string;
	ciphertext: Buffer;
	readLimit: number;
	expiresAt: Date;
};

export class WhisperRepository {
	public constructor(private readonly sql: Sql) {}

	public async create(input: CreateWhisperInput): Promise<{ id: string; publicId: string }> {
		const rows = await this.sql<{ id: string; public_id: string }[]>`
			insert into whispers (public_id, plan_id, read_token_hash, ciphertext, read_limit, expires_at)
			values (${input.publicId}, ${input.planId}, ${input.readTokenHash}, ${input.ciphertext}, ${input.readLimit}, ${input.expiresAt})
			returning id, public_id
		`;
		const row = rows[0];
		if (row === undefined) throw new Error("WHISPER creation returned no resource");
		return { id: row.id, publicId: row.public_id };
	}

	public async getCredentialHash(publicId: string): Promise<string | null> {
		const rows = await this.sql<{ read_token_hash: string }[]>`
			select read_token_hash
			from whispers
			where public_id = ${publicId}
				and status = 'active'
				and clock_timestamp() < expires_at
		`;
		return rows[0]?.read_token_hash ?? null;
	}

	public async consume(publicId: string): Promise<Buffer | null> {
		return this.sql.begin(async (tx) => {
			const rows = await tx<{ id: string; ciphertext: Buffer; read_count: number; read_limit: number; is_expired: boolean }[]>`
				select id, ciphertext, read_count, read_limit, clock_timestamp() >= expires_at as is_expired
				from whispers
				where public_id = ${publicId} and status = 'active'
				for update
			`;
			const row = rows[0];
			if (row === undefined) return null;
			if (row.is_expired) {
				await tx`
					update whispers
					set status = 'expired', ciphertext = null, read_token_hash = null,
						expired_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = ${row.id}
				`;
				return null;
			}
			const finalRead = row.read_count + 1 >= row.read_limit;
			if (finalRead) {
				await tx`
					update whispers
					set status = 'consumed', read_count = read_limit, ciphertext = null, read_token_hash = null,
						consumed_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = ${row.id}
				`;
			} else {
				await tx`update whispers set read_count = read_count + 1, updated_at = clock_timestamp() where id = ${row.id}`;
			}
			return row.ciphertext;
		});
	}

	public async expireDue(requestedLimit = 100): Promise<number> {
		const limit = Math.max(1, Math.min(1_000, requestedLimit));
		return this.sql.begin(async (tx) => {
			const rows = await tx<{ id: string }[]>`
				select id from whispers
				where status = 'active' and clock_timestamp() >= expires_at
				order by expires_at asc
				limit ${limit}
				for update skip locked
			`;
			if (rows.length === 0) return 0;
			const ids = rows.map((row) => row.id);
			const expired = await tx`
				update whispers
				set status = 'expired', ciphertext = null, read_token_hash = null,
					expired_at = clock_timestamp(), updated_at = clock_timestamp()
				where id in ${tx(ids)}
			`;
			return expired.count;
		});
	}
}
