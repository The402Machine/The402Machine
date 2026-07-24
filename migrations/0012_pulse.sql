DO $$
DECLARE
	constraint_name text;
BEGIN
	FOR constraint_name IN
		SELECT conname
		FROM pg_constraint
		WHERE conrelid = 'payment_orders'::regclass
			AND contype = 'c'
			AND (
				pg_get_constraintdef(oid) LIKE '%product_payload%'
				OR pg_get_constraintdef(oid) LIKE '%whisper_read_limit%'
			)
	LOOP
		EXECUTE format('ALTER TABLE payment_orders DROP CONSTRAINT %I', constraint_name);
	END LOOP;
END $$;
ALTER TABLE payment_orders ALTER COLUMN product DROP DEFAULT;
ALTER TABLE payment_orders ALTER COLUMN product TYPE text USING product::text;
DROP TYPE payment_product;
CREATE TYPE payment_product AS ENUM ('catch', 'whisper', 'pulse');
ALTER TABLE payment_orders ALTER COLUMN product TYPE payment_product USING product::payment_product;
ALTER TABLE payment_orders ALTER COLUMN product SET DEFAULT 'catch'::payment_product;

DO $$ BEGIN
	CREATE TYPE pulse_status AS ENUM ('active', 'exhausted', 'expired', 'manually_destroyed');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pulse_resources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	public_id text NOT NULL UNIQUE CHECK (public_id ~ '^pulse_[A-Za-z0-9_-]{22,}$'),
	plan_id catch_plan_id NOT NULL,
	status pulse_status NOT NULL DEFAULT 'active',
	owner_token_hash text,
	ping_token_hash text,
	heartbeat_limit integer NOT NULL CHECK (heartbeat_limit > 0),
	heartbeat_count integer NOT NULL DEFAULT 0 CHECK (heartbeat_count >= 0 AND heartbeat_count <= heartbeat_limit),
	expected_interval_seconds integer NOT NULL CHECK (expected_interval_seconds BETWEEN 20 AND 604800),
	grace_seconds integer NOT NULL CHECK (grace_seconds BETWEEN 60 AND 604800),
	name text NOT NULL DEFAULT 'Untitled monitor' CHECK (length(name) BETWEEN 1 AND 80),
	description text NOT NULL DEFAULT '' CHECK (length(description) <= 240),
	public_status_enabled boolean NOT NULL DEFAULT false,
	last_ping_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	expires_at timestamptz NOT NULL,
	exhausted_at timestamptz,
	expired_at timestamptz,
	destroyed_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK (expires_at > created_at),
	CHECK (
		(status = 'active' AND owner_token_hash IS NOT NULL AND ping_token_hash IS NOT NULL AND heartbeat_count < heartbeat_limit)
		OR (status = 'exhausted' AND owner_token_hash IS NOT NULL AND ping_token_hash IS NULL AND heartbeat_count = heartbeat_limit)
		OR (status IN ('expired', 'manually_destroyed') AND owner_token_hash IS NULL AND ping_token_hash IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS pulse_expiry_candidates_idx ON pulse_resources (expires_at) WHERE status IN ('active', 'exhausted');

ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_payload_check CHECK (
	(product IN ('catch', 'pulse') AND product_payload IS NULL)
	OR (product = 'whisper' AND status <> 'dispensed' AND product_payload IS NOT NULL AND octet_length(product_payload) BETWEEN 30 AND 4215276)
	OR (product = 'whisper' AND status = 'dispensed' AND product_payload IS NULL)
);

ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_whisper_read_limit_check CHECK (
	(product IN ('catch', 'pulse') AND whisper_read_limit IS NULL)
	OR (product = 'whisper' AND (
		(plan_id = 'spark' AND whisper_read_limit = 1)
		OR (plan_id = 'standard' AND whisper_read_limit IN (1, 42))
		OR (plan_id = 'long' AND whisper_read_limit IN (1, 402))
	))
);

INSERT INTO schema_migrations (version) VALUES ('0012_pulse') ON CONFLICT (version) DO NOTHING;
