ALTER TABLE whispers
	ADD COLUMN IF NOT EXISTS read_limit integer NOT NULL DEFAULT 1,
	ADD COLUMN IF NOT EXISTS read_count integer NOT NULL DEFAULT 0;

ALTER TABLE whispers
	ADD CONSTRAINT whispers_read_counters_check CHECK (
		read_limit BETWEEN 1 AND 402
		AND read_count BETWEEN 0 AND read_limit
	);

INSERT INTO schema_migrations (version)
VALUES ('0010_whisper_multiread')
ON CONFLICT (version) DO NOTHING;
