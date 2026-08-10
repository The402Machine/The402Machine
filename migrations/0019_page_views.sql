CREATE TABLE IF NOT EXISTS page_view_daily (
	day date NOT NULL DEFAULT (timezone('UTC', clock_timestamp()))::date,
	path text NOT NULL CHECK (path IN ('/', '/api', '/demo', '/catch', '/whisper', '/pulse', '/pulse-public', '/stats')),
	views bigint NOT NULL DEFAULT 0 CHECK (views >= 0),
	PRIMARY KEY (day, path)
);

INSERT INTO schema_migrations (version)
VALUES ('0019_page_views')
ON CONFLICT (version) DO NOTHING;
