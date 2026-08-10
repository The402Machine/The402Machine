CREATE TABLE IF NOT EXISTS platform_events (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	order_id uuid NOT NULL,
	event_type text NOT NULL CHECK (event_type IN ('payment_paid', 'resource_dispensed')),
	product payment_product NOT NULL,
	plan_id catch_plan_id NOT NULL,
	amount_sats integer NOT NULL CHECK (amount_sats > 0),
	occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
	UNIQUE (order_id, event_type)
);

CREATE INDEX IF NOT EXISTS platform_events_type_product_idx
	ON platform_events (event_type, product);

CREATE OR REPLACE FUNCTION record_platform_order_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.paid_at IS NOT NULL THEN
		INSERT INTO platform_events (order_id, event_type, product, plan_id, amount_sats, occurred_at)
		VALUES (NEW.id, 'payment_paid', NEW.product, NEW.plan_id, NEW.amount_sats, NEW.paid_at)
		ON CONFLICT (order_id, event_type) DO NOTHING;
	END IF;
	IF NEW.dispensed_at IS NOT NULL THEN
		INSERT INTO platform_events (order_id, event_type, product, plan_id, amount_sats, occurred_at)
		VALUES (NEW.id, 'resource_dispensed', NEW.product, NEW.plan_id, NEW.amount_sats, NEW.dispensed_at)
		ON CONFLICT (order_id, event_type) DO NOTHING;
	END IF;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_orders_platform_events ON payment_orders;
CREATE TRIGGER payment_orders_platform_events
AFTER INSERT OR UPDATE OF paid_at, dispensed_at ON payment_orders
FOR EACH ROW EXECUTE FUNCTION record_platform_order_events();

INSERT INTO platform_events (order_id, event_type, product, plan_id, amount_sats, occurred_at)
SELECT id, 'payment_paid', product, plan_id, amount_sats, paid_at
FROM payment_orders
WHERE paid_at IS NOT NULL
ON CONFLICT (order_id, event_type) DO NOTHING;

INSERT INTO platform_events (order_id, event_type, product, plan_id, amount_sats, occurred_at)
SELECT id, 'resource_dispensed', product, plan_id, amount_sats, dispensed_at
FROM payment_orders
WHERE dispensed_at IS NOT NULL
ON CONFLICT (order_id, event_type) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0018_platform_events')
ON CONFLICT (version) DO NOTHING;
