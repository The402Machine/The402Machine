CREATE TABLE IF NOT EXISTS gate_projects (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	public_id text NOT NULL UNIQUE CHECK (public_id ~ '^gate_project_[A-Za-z0-9_-]{16,64}$'),
	display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
	lightning_address text NOT NULL CHECK (char_length(lightning_address) BETWEEN 3 AND 320 AND lightning_address = lower(lightning_address) AND lightning_address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	admin_token_hash text NOT NULL CHECK (admin_token_hash ~ '^[a-f0-9]{64}$'),
	api_token_hash text NOT NULL CHECK (api_token_hash ~ '^[a-f0-9]{64}$'),
	monthly_free_limit integer NOT NULL DEFAULT 25 CHECK (monthly_free_limit = 25),
	active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS gate_routes (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id uuid NOT NULL REFERENCES gate_projects(id) ON DELETE CASCADE,
	route_key text NOT NULL CHECK (route_key ~ '^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$'),
	method text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD')),
	path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 2048 AND path LIKE '/%' AND path NOT LIKE '%?%' AND path NOT LIKE '%#%' AND path NOT LIKE '//%'),
	price_sats integer NOT NULL CHECK (price_sats BETWEEN 1 AND 1000000),
	active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	UNIQUE (project_id, route_key),
	UNIQUE (project_id, method, path)
);

CREATE TABLE IF NOT EXISTS gate_intents (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	public_id text NOT NULL UNIQUE CHECK (public_id ~ '^gate_intent_[A-Za-z0-9_-]{16,64}$'),
	project_id uuid NOT NULL REFERENCES gate_projects(id) ON DELETE CASCADE,
	route_id uuid NOT NULL REFERENCES gate_routes(id) ON DELETE RESTRICT,
	idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
	method text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD')),
	path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 2048 AND path LIKE '/%' AND path NOT LIKE '%?%' AND path NOT LIKE '%#%'),
	body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
	amount_sats integer NOT NULL CHECK (amount_sats BETWEEN 1 AND 1000000),
	lightning_address text NOT NULL CHECK (char_length(lightning_address) BETWEEN 3 AND 320 AND lightning_address = lower(lightning_address) AND lightning_address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	state text NOT NULL DEFAULT 'pending_invoice' CHECK (state IN ('pending_invoice', 'invoice_issuing', 'invoice_issued', 'invoice_uncertain', 'paid', 'authorized', 'expired', 'failed')),
	bolt11 text,
	payment_hash text UNIQUE CHECK (payment_hash IS NULL OR payment_hash ~ '^[a-f0-9]{64}$'),
	verify_url text CHECK (verify_url IS NULL OR (verify_url LIKE 'https://%' AND char_length(verify_url) <= 2048)),
	receipt text CHECK (receipt IS NULL OR char_length(receipt) BETWEEN 64 AND 8192),
	invoice_expires_at timestamptz,
	paid_at timestamptz,
	authorized_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	UNIQUE (project_id, idempotency_key),
	CHECK ((state = 'pending_invoice' AND bolt11 IS NULL AND payment_hash IS NULL AND invoice_expires_at IS NULL) OR state <> 'pending_invoice'),
	CHECK ((state IN ('invoice_issued', 'paid', 'authorized', 'expired') AND bolt11 IS NOT NULL AND payment_hash IS NOT NULL AND invoice_expires_at IS NOT NULL) OR state NOT IN ('invoice_issued', 'paid', 'authorized', 'expired')),
	CHECK ((paid_at IS NOT NULL) = (state IN ('paid', 'authorized'))),
	CHECK ((authorized_at IS NOT NULL) = (state = 'authorized')),
	CHECK ((receipt IS NOT NULL) = (state = 'authorized'))
);

CREATE INDEX IF NOT EXISTS gate_intents_project_created_idx ON gate_intents (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gate_intents_pending_expiry_idx ON gate_intents (invoice_expires_at) WHERE state = 'invoice_issued';

CREATE TABLE IF NOT EXISTS gate_credit_grants (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id uuid NOT NULL REFERENCES gate_projects(id) ON DELETE CASCADE,
	source_order_id uuid NOT NULL UNIQUE,
	pack_id text NOT NULL CHECK (pack_id IN ('spark', 'standard', 'long')),
	total_authorizations integer NOT NULL,
	remaining_authorizations integer NOT NULL,
	purchased_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK (remaining_authorizations BETWEEN 0 AND total_authorizations),
	CHECK ((pack_id = 'spark' AND total_authorizations = 420) OR (pack_id = 'standard' AND total_authorizations = 4200) OR (pack_id = 'long' AND total_authorizations = 42000)),
	CHECK (expires_at > purchased_at)
);

CREATE INDEX IF NOT EXISTS gate_credit_grants_consumption_idx ON gate_credit_grants (project_id, expires_at, purchased_at) WHERE remaining_authorizations > 0;

CREATE TABLE IF NOT EXISTS gate_authorizations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	intent_id uuid NOT NULL UNIQUE REFERENCES gate_intents(id) ON DELETE CASCADE,
	receipt_jti text NOT NULL UNIQUE CHECK (receipt_jti ~ '^[A-Za-z0-9_-]{32,64}$'),
	source text NOT NULL CHECK (source IN ('monthly_free', 'prepaid_grant')),
	source_month date,
	grant_id uuid REFERENCES gate_credit_grants(id) ON DELETE RESTRICT,
	project_id uuid NOT NULL REFERENCES gate_projects(id) ON DELETE CASCADE,
	consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK ((source = 'monthly_free' AND source_month IS NOT NULL AND grant_id IS NULL) OR (source = 'prepaid_grant' AND source_month IS NULL AND grant_id IS NOT NULL)),
	CHECK (source_month IS NULL OR source_month = date_trunc('month', source_month)::date)
);

CREATE INDEX IF NOT EXISTS gate_authorizations_monthly_usage_idx ON gate_authorizations (project_id, source_month, consumed_at) WHERE source = 'monthly_free';
