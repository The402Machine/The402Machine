UPDATE catch_events AS event
SET headers = coalesce((
	SELECT jsonb_object_agg(entry.key, entry.value)
	FROM jsonb_each(event.headers) AS entry
	WHERE entry.key IN (
		'content-type',
		'user-agent',
		'x-request-id',
		'x-github-event',
		'x-github-delivery',
		'stripe-signature'
	)
), '{}'::jsonb);

WITH measured_events AS (
	SELECT
		event.id,
		sum(catch_event_stored_bytes(event.headers, event.body)) OVER (
			PARTITION BY event.resource_id
			ORDER BY event.sequence_number, event.id
		) AS cumulative_bytes,
		resource.storage_limit_bytes
	FROM catch_events AS event
	JOIN catch_resources AS resource ON resource.id = event.resource_id
)
DELETE FROM catch_events AS event
USING measured_events AS measured
WHERE event.id = measured.id
	AND measured.cumulative_bytes > measured.storage_limit_bytes;

WITH resource_totals AS (
	SELECT
		resource.id,
		coalesce(sum(catch_event_stored_bytes(event.headers, event.body)), 0) AS stored_bytes
	FROM catch_resources AS resource
	LEFT JOIN catch_events AS event ON event.resource_id = resource.id
	GROUP BY resource.id
)
UPDATE catch_resources AS resource
SET stored_bytes = totals.stored_bytes,
	status = CASE
		WHEN resource.status = 'active'
			AND (
				resource.accepted_request_count >= resource.request_limit
				OR totals.stored_bytes >= resource.storage_limit_bytes
			)
		THEN 'exhausted'::catch_resource_status
		ELSE resource.status
	END,
	updated_at = clock_timestamp()
FROM resource_totals AS totals
WHERE totals.id = resource.id;

ALTER TABLE catch_events
	VALIDATE CONSTRAINT catch_events_headers_allowlist_check;

INSERT INTO schema_migrations (version) VALUES ('0005_catch_storage_reconcile') ON CONFLICT DO NOTHING;