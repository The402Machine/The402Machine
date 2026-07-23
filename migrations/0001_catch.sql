CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
	CREATE TYPE catch_plan_id AS ENUM ('spark', 'standard', 'long');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE catch_resource_status AS ENUM (
		'active',
		'exhausted',
		'expired',
		'suspended',
		'manually_destroyed',
		'deleted'
	);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS catch_resources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	public_id text NOT NULL UNIQUE CHECK (public_id ~ '^catch_[A-Za-z0-9_-]{22,}$'),
	plan_id catch_plan_id NOT NULL,
	status catch_resource_status NOT NULL DEFAULT 'active',
	owner_token_hash text,
	ingest_token_hash text,
	request_limit integer NOT NULL CHECK (request_limit > 0),
	storage_limit_bytes bigint NOT NULL CHECK (storage_limit_bytes > 0),
	max_bytes_per_request integer NOT NULL CHECK (max_bytes_per_request > 0),
	accepted_request_count integer NOT NULL DEFAULT 0 CHECK (accepted_request_count >= 0),
	stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	expires_at timestamptz NOT NULL,
	exhausted_at timestamptz,
	expired_at timestamptz,
	suspended_at timestamptz,
	manually_destroyed_at timestamptz,
	deleted_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK (expires_at > created_at),
	CHECK (accepted_request_count <= request_limit),
	CHECK (stored_bytes <= storage_limit_bytes),
	CHECK ((status IN ('active', 'exhausted', 'suspended')) OR (owner_token_hash IS NULL AND ingest_token_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS catch_resources_expiry_candidates_idx
	ON catch_resources (expires_at)
	WHERE status IN ('active', 'exhausted', 'suspended');

CREATE TABLE IF NOT EXISTS catch_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	resource_id uuid NOT NULL REFERENCES catch_resources(id) ON DELETE CASCADE,
	sequence_number integer NOT NULL CHECK (sequence_number > 0),
	content_type text NOT NULL,
	headers jsonb NOT NULL DEFAULT '{}'::jsonb,
	body bytea NOT NULL,
	body_bytes integer GENERATED ALWAYS AS (octet_length(body)) STORED,
	received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	UNIQUE (resource_id, sequence_number),
	CHECK (jsonb_typeof(headers) = 'object')
);

CREATE INDEX IF NOT EXISTS catch_events_resource_received_idx
	ON catch_events (resource_id, received_at DESC, sequence_number DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
	version text PRIMARY KEY,
	applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO schema_migrations (version)
VALUES ('0001_catch')
ON CONFLICT (version) DO NOTHING;
