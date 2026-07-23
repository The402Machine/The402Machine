import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
	throw new Error("DATABASE_URL is required to run migrations");
}

const migrationsDirectory = resolve(process.cwd(), "migrations");
const migrationFiles = (await readdir(migrationsDirectory))
	.filter((file) => /^\d+_[a-z0-9_-]+\.sql$/u.test(file))
	.sort();
const sql = postgres(databaseUrl, { max: 1 });

try {
	await sql.unsafe(`
		create table if not exists schema_migrations (
			version text primary key,
			applied_at timestamptz not null default clock_timestamp()
		)
	`).simple();

	for (const migrationFile of migrationFiles) {
		const version = migrationFile.replace(/\.sql$/u, "");
		const [applied] = await sql`select 1 from schema_migrations where version = ${version}`;
		if (applied !== undefined) continue;

		const migration = await readFile(resolve(migrationsDirectory, migrationFile), "utf8");
		await sql.begin(async (transaction) => {
			await transaction.unsafe(migration).simple();
			await transaction`
				insert into schema_migrations (version) values (${version})
				on conflict (version) do nothing
			`;
		});
		console.log(`Applied migration ${version}`);
	}
} finally {
	await sql.end();
}
