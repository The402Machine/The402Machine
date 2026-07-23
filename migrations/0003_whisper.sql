DO $$ BEGIN
	CREATE TYPE whisper_status AS ENUM ('active', 'consumed', 'expired');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS whispers (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	public_id text NOT NULL UNIQUE CHECK (public_id ~ '^whisper_[A-Za-z0-9_-]{22,}$'),
	plan_id catch_plan_id NOT NULL,
	status whisper_status NOT NULL DEFAULT 'active',
	read_token_hash text,
	ciphertext bytea,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	expires_at timestamptz NOT NULL,
	consumed_at timestamptz,
	expired_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK (expires_at > created_at),
	CHECK (ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 1 AND 16384),
	CHECK (
		(status = 'active' AND read_token_hash IS NOT NULL AND ciphertext IS NOT NULL)
		OR
		(status IN ('consumed', 'expired') AND read_token_hash IS NULL AND ciphertext IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS whispers_expiry_candidates_idx
	ON whispers (expires_at)
	WHERE status = 'active';

INSERT INTO schema_migrations (version)
VALUES ('0003_whisper')
ON CONFLICT (version) DO NOTHING;
