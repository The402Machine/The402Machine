DO $$
DECLARE
	constraint_name text;
BEGIN
	FOR constraint_name IN
		SELECT conname
		FROM pg_constraint
		WHERE conrelid = 'payment_orders'::regclass
			AND contype = 'c'
			AND pg_get_constraintdef(oid) LIKE '%octet_length(product_payload)%'
	LOOP
		EXECUTE format('ALTER TABLE payment_orders DROP CONSTRAINT %I', constraint_name);
	END LOOP;
END $$;

ALTER TABLE payment_orders
	ADD CONSTRAINT payment_orders_payload_check CHECK (
		(product = 'catch' AND product_payload IS NULL)
		OR (product = 'whisper' AND status <> 'dispensed' AND product_payload IS NOT NULL AND octet_length(product_payload) BETWEEN 30 AND 4215276)
		OR (product = 'whisper' AND status = 'dispensed' AND product_payload IS NULL)
	);

DO $$
DECLARE
	constraint_name text;
BEGIN
	FOR constraint_name IN
		SELECT conname
		FROM pg_constraint
		WHERE conrelid = 'whispers'::regclass
			AND contype = 'c'
			AND pg_get_constraintdef(oid) LIKE '%octet_length(ciphertext)%'
	LOOP
		EXECUTE format('ALTER TABLE whispers DROP CONSTRAINT %I', constraint_name);
	END LOOP;
END $$;

ALTER TABLE whispers
	ADD CONSTRAINT whispers_ciphertext_check CHECK (
		ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 1 AND 4215276
	);

INSERT INTO schema_migrations (version)
VALUES ('0007_whisper_payload_v2')
ON CONFLICT (version) DO NOTHING;
