ALTER TABLE whispers
	DROP CONSTRAINT IF EXISTS whispers_reveal_window_check;

ALTER TABLE whispers
	ADD CONSTRAINT whispers_reveal_window_check CHECK (
		whisper_reveal_at >= created_at - interval '1 second'
		AND (
			whisper_reveal_at <= created_at + interval '1 second'
			OR whisper_reveal_at <= expires_at - interval '1 hour'
		)
	);

INSERT INTO schema_migrations (version)
VALUES ('0014_whisper_reveal_window')
ON CONFLICT (version) DO NOTHING;
