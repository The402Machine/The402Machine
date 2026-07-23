DO $$ BEGIN
	CREATE TYPE payment_order_status AS ENUM (
		'created',
		'invoice_issued',
		'paid',
		'dispensed',
		'expired',
		'failed'
	);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	CREATE TYPE payment_product AS ENUM ('catch', 'whisper');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payment_orders (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
	product payment_product NOT NULL DEFAULT 'catch',
	plan_id catch_plan_id NOT NULL,
	product_payload bytea,
	amount_sats integer NOT NULL CHECK (amount_sats > 0),
	status payment_order_status NOT NULL DEFAULT 'created',
	payment_hash text UNIQUE CHECK (payment_hash IS NULL OR payment_hash ~ '^[a-f0-9]{64}$'),
	bolt11 text,
	resource_id uuid UNIQUE,
	delivery_ciphertext bytea,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	invoice_issued_at timestamptz,
	paid_at timestamptz,
	dispensed_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK (
		(product = 'catch' AND product_payload IS NULL)
		OR (product = 'whisper' AND status <> 'dispensed' AND product_payload IS NOT NULL AND octet_length(product_payload) BETWEEN 30 AND 16384)
		OR (product = 'whisper' AND status = 'dispensed' AND product_payload IS NULL)
	),
	CHECK (
		(status = 'created' AND payment_hash IS NULL AND bolt11 IS NULL)
		OR (status IN ('invoice_issued', 'paid', 'dispensed') AND payment_hash IS NOT NULL AND bolt11 IS NOT NULL)
		OR status IN ('expired', 'failed')
	),
	CHECK (
		(plan_id = 'spark' AND amount_sats = 4)
		OR (plan_id = 'standard' AND amount_sats = 42)
		OR (plan_id = 'long' AND amount_sats = 402)
	),
	CHECK (status <> 'paid' OR paid_at IS NOT NULL),
	CHECK (status <> 'dispensed' OR (paid_at IS NOT NULL AND dispensed_at IS NOT NULL AND resource_id IS NOT NULL AND delivery_ciphertext IS NOT NULL))
);

INSERT INTO schema_migrations (version)
VALUES ('0002_payments')
ON CONFLICT (version) DO NOTHING;
