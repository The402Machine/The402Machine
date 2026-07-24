ALTER TABLE payment_orders
	ADD COLUMN IF NOT EXISTS whisper_reveal_at timestamptz;

ALTER TABLE whispers
	ADD COLUMN IF NOT EXISTS whisper_reveal_at timestamptz;

UPDATE whispers
SET whisper_reveal_at = created_at
WHERE whisper_reveal_at IS NULL;

ALTER TABLE whispers
	ALTER COLUMN whisper_reveal_at SET DEFAULT clock_timestamp(),
	ALTER COLUMN whisper_reveal_at SET NOT NULL;

ALTER TABLE whispers
	DROP CONSTRAINT IF EXISTS whispers_reveal_window_check;

ALTER TABLE whispers
	ADD CONSTRAINT whispers_reveal_window_check CHECK (
		whisper_reveal_at <= created_at + interval '1 second'
		OR whisper_reveal_at <= expires_at - interval '1 hour'
	);

ALTER TABLE payment_orders
	DROP CONSTRAINT IF EXISTS payment_orders_whisper_reveal_check;

ALTER TABLE payment_orders
	ADD CONSTRAINT payment_orders_whisper_reveal_check CHECK (
		(product IN ('catch', 'pulse') AND whisper_reveal_at IS NULL)
		OR product = 'whisper'
	);

INSERT INTO schema_migrations (version)
VALUES ('0013_whisper_scheduled_reveal')
ON CONFLICT (version) DO NOTHING;
