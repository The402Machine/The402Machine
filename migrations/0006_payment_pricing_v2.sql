ALTER TABLE payment_orders
	DROP CONSTRAINT IF EXISTS payment_orders_check2,
	DROP CONSTRAINT IF EXISTS payment_orders_price_check;

ALTER TABLE payment_orders
	ADD CONSTRAINT payment_orders_price_check CHECK (
		(plan_id = 'spark' AND amount_sats IN (4, 42))
		OR (plan_id = 'standard' AND amount_sats IN (42, 402))
		OR (plan_id = 'long' AND amount_sats IN (402, 4002))
	);

INSERT INTO schema_migrations (version)
VALUES ('0006_payment_pricing_v2')
ON CONFLICT (version) DO NOTHING;
