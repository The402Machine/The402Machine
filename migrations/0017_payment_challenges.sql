CREATE TABLE IF NOT EXISTS payment_challenges (
	challenge_id text PRIMARY KEY CHECK (challenge_id ~ '^[A-Za-z0-9_-]{43}$'),
	order_id uuid NOT NULL UNIQUE REFERENCES payment_orders(id) ON DELETE CASCADE,
	protocol text NOT NULL CHECK (protocol IN ('payment', 'l402')),
	challenge_fingerprint text NOT NULL CHECK (challenge_fingerprint ~ '^[a-f0-9]{64}$'),
	payment_hash text NOT NULL CHECK (payment_hash ~ '^[a-f0-9]{64}$'),
	expires_at timestamptz NOT NULL,
	consumed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS payment_challenges_expiry_idx
	ON payment_challenges (expires_at)
	WHERE consumed_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0017_payment_challenges')
ON CONFLICT (version) DO NOTHING;
