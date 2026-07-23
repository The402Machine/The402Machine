ALTER TABLE catch_resources
	ADD COLUMN IF NOT EXISTS ingest_auth_required boolean NOT NULL DEFAULT true;

ALTER TABLE catch_events
	ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'POST',
	ADD COLUMN IF NOT EXISTS authenticated boolean NOT NULL DEFAULT true;

ALTER TABLE catch_events
	ADD CONSTRAINT catch_events_method_check CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'));

CREATE INDEX IF NOT EXISTS catch_events_resource_access_method_idx
	ON catch_events (resource_id, authenticated, method, sequence_number DESC);

INSERT INTO schema_migrations (version) VALUES ('0008_catch_flexible_ingest') ON CONFLICT DO NOTHING;
