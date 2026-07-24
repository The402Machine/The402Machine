ALTER TABLE payment_orders
	ADD COLUMN IF NOT EXISTS whisper_read_limit integer;

UPDATE payment_orders
SET whisper_read_limit = CASE plan_id
	WHEN 'spark' THEN 1
	WHEN 'standard' THEN 42
	WHEN 'long' THEN 402
END
WHERE product = 'whisper' AND whisper_read_limit IS NULL;

ALTER TABLE payment_orders
	DROP CONSTRAINT IF EXISTS payment_orders_whisper_read_limit_check;

ALTER TABLE payment_orders
	ADD CONSTRAINT payment_orders_whisper_read_limit_check CHECK (
		(product = 'catch' AND whisper_read_limit IS NULL)
		OR (
			product = 'whisper'
			AND whisper_read_limit IS NOT NULL
			AND (
				whisper_read_limit = 1
				OR (plan_id = 'standard' AND whisper_read_limit = 42)
				OR (plan_id = 'long' AND whisper_read_limit = 402)
			)
		)
	);

INSERT INTO schema_migrations (version)
VALUES ('0011_whisper_burn_after_read')
ON CONFLICT (version) DO NOTHING;
