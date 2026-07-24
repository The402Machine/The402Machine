ALTER TABLE payment_orders
	DROP CONSTRAINT IF EXISTS payment_orders_whisper_read_limit_check;

ALTER TABLE payment_orders
	ADD CONSTRAINT payment_orders_whisper_read_limit_check CHECK (
		(product IN ('catch', 'pulse') AND whisper_read_limit IS NULL)
		OR (product = 'whisper' AND (
			(plan_id = 'spark' AND whisper_read_limit = 1)
			OR (plan_id = 'standard' AND whisper_read_limit BETWEEN 1 AND 42)
			OR (plan_id = 'long' AND whisper_read_limit BETWEEN 1 AND 402)
		))
	);

INSERT INTO schema_migrations (version)
VALUES ('0015_whisper_custom_read_limit')
ON CONFLICT (version) DO NOTHING;