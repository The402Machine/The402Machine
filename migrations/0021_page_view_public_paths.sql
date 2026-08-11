ALTER TABLE page_view_daily
	DROP CONSTRAINT IF EXISTS page_view_daily_path_check;

ALTER TABLE page_view_daily
	ADD CONSTRAINT page_view_daily_path_check
	CHECK (path IN (
		'/',
		'/api',
		'/demo',
		'/catch',
		'/whisper',
		'/pulse',
		'/pulse-public',
		'/stats',
		'/agents',
		'/gate',
		'/install',
		'/changelog'
	));
