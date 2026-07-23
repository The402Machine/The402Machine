ALTER TABLE catch_events
	ADD CONSTRAINT catch_events_headers_allowlist_check CHECK (
		headers - ARRAY[
			'content-type',
			'user-agent',
			'x-request-id',
			'x-github-event',
			'x-github-delivery',
			'stripe-signature'
		]::text[] = '{}'::jsonb
	);

CREATE OR REPLACE FUNCTION catch_event_stored_bytes(event_headers jsonb, event_body bytea)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
	SELECT octet_length(event_body) + octet_length(event_headers::text);
$$;

INSERT INTO schema_migrations (version) VALUES ('0004_catch_storage_hardening') ON CONFLICT DO NOTHING;
