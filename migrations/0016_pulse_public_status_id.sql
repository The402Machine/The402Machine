ALTER TABLE pulse_resources
	ADD COLUMN IF NOT EXISTS public_status_id text;

UPDATE pulse_resources
SET public_status_id = 'pulse_status_' || encode(gen_random_bytes(16), 'hex')
WHERE public_status_id IS NULL;

ALTER TABLE pulse_resources
	ALTER COLUMN public_status_id SET DEFAULT ('pulse_status_' || encode(gen_random_bytes(16), 'hex')),
	ALTER COLUMN public_status_id SET NOT NULL;

DO $$ BEGIN
	ALTER TABLE pulse_resources
		ADD CONSTRAINT pulse_resources_public_status_id_format_check
		CHECK (public_status_id ~ '^pulse_status_[A-Za-z0-9_-]{32}$');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pulse_resources_public_status_id_idx
	ON pulse_resources (public_status_id);

INSERT INTO schema_migrations (version) VALUES ('0016_pulse_public_status_id') ON CONFLICT (version) DO NOTHING;
