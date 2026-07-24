ALTER TABLE catch_resources
	ALTER COLUMN ingest_auth_required SET DEFAULT false;

UPDATE catch_resources
SET ingest_auth_required = false,
	updated_at = clock_timestamp()
WHERE ingest_auth_required = true;

ALTER TABLE catch_events
	ADD COLUMN IF NOT EXISTS source_ip inet,
	ADD COLUMN IF NOT EXISTS ip_location jsonb;

ALTER TABLE catch_events
	ADD CONSTRAINT catch_events_ip_location_object_check
	CHECK (ip_location IS NULL OR jsonb_typeof(ip_location) = 'object');

CREATE OR REPLACE FUNCTION catch_event_stored_bytes(event_headers jsonb, event_body bytea, event_source_ip inet, event_ip_location jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT octet_length(event_body)
		+ octet_length(coalesce(event_headers, '{}'::jsonb)::text)
		+ octet_length(coalesce(host(event_source_ip), ''))
		+ coalesce(octet_length(event_ip_location::text), 0);
$$;

CREATE OR REPLACE FUNCTION catch_event_stored_bytes(event_headers jsonb, event_body bytea)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
	SELECT catch_event_stored_bytes(event_headers, event_body, NULL, NULL);
$$;

WITH resource_totals AS (
	SELECT resource.id, coalesce(sum(catch_event_stored_bytes(event.headers, event.body, event.source_ip, event.ip_location)), 0) AS stored_bytes
	FROM catch_resources AS resource
	LEFT JOIN catch_events AS event ON event.resource_id = resource.id
	GROUP BY resource.id
)
UPDATE catch_resources AS resource
SET stored_bytes = totals.stored_bytes,
	updated_at = clock_timestamp()
FROM resource_totals AS totals
WHERE resource.id = totals.id;

INSERT INTO schema_migrations (version) VALUES ('0009_catch_ip_metadata') ON CONFLICT DO NOTHING;
