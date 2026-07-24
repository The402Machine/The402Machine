import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WhisperRepository } from "../../src/whisper/whisper-repository.js";

const image = "postgres:17-alpine";
const container = `the402machine-whisper-test-${randomUUID()}`;
const password = "whisper-test-password";
let databaseUrl = "";
let sql: ReturnType<typeof postgres>;
let repository: WhisperRepository;

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" }).trim();

const waitForPostgres = async (): Promise<void> => {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const probe = postgres(databaseUrl, { max: 1, connect_timeout: 1 });
			await probe`select 1`;
			await probe.end();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error("PostgreSQL WHISPER test container did not become ready");
};

beforeAll(async () => {
	docker("pull", image);
	docker("run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=the402machine_test", image);
	const port = docker("port", container, "5432/tcp").split(":").at(-1);
	if (port === undefined) throw new Error("Could not determine PostgreSQL test port");
	databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/the402machine_test`;
	await waitForPostgres();
	sql = postgres(databaseUrl, { max: 12 });
	for (const migrationName of ["0001_catch.sql", "0003_whisper.sql", "0010_whisper_multiread.sql"]) {
		const migration = await readFile(new URL(`../../migrations/${migrationName}`, import.meta.url), "utf8");
		await sql.unsafe(migration).simple();
	}
	repository = new WhisperRepository(sql);
}, 60_000);

afterAll(async () => {
	await sql?.end();
	try { docker("rm", "--force", container); } catch { /* container already removed */ }
});

const createWhisper = async (overrides: { expiresAt?: Date; readLimit?: number; planId?: "spark" | "standard" | "long" } = {}) => repository.create({
	publicId: `whisper_${randomUUID().replaceAll("-", "")}`,
	planId: overrides.planId ?? "spark",
	readTokenHash: randomUUID().replaceAll("-", ""),
	ciphertext: Buffer.from("opaque-client-ciphertext"),
	readLimit: overrides.readLimit ?? 1,
	expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
});

describe("WhisperRepository", () => {
	it("atomically consumes ciphertext exactly once under concurrent reads", async () => {
		const whisper = await createWhisper();
		const results = await Promise.all(Array.from({ length: 8 }, async () => repository.consume(whisper.publicId)));
		expect(results.filter((result) => result !== null)).toHaveLength(1);
		expect(results.find((result) => result !== null)?.toString()).toBe("opaque-client-ciphertext");
		expect(await repository.consume(whisper.publicId)).toBeNull();
	});

	it("serves exactly the configured number of reads under concurrency", async () => {
		const whisper = await createWhisper({ planId: "standard", readLimit: 42 });
		const results = await Promise.all(Array.from({ length: 60 }, async () => repository.consume(whisper.publicId)));
		expect(results.filter((result) => result !== null)).toHaveLength(42);
		expect(results.filter((result) => result?.toString() === "opaque-client-ciphertext")).toHaveLength(42);
		expect(await repository.consume(whisper.publicId)).toBeNull();
		expect(await repository.getCredentialHash(whisper.publicId)).toBeNull();
	});

	it("does not reveal and purges an expired whisper", async () => {
		const whisper = await createWhisper({ expiresAt: new Date(Date.now() + 100) });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(await repository.consume(whisper.publicId)).toBeNull();
		expect(await repository.getCredentialHash(whisper.publicId)).toBeNull();
	});

	it("purges idle expired whispers in bounded batches", async () => {
		await createWhisper({ expiresAt: new Date(Date.now() + 100) });
		await createWhisper({ expiresAt: new Date(Date.now() + 100) });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(await repository.expireDue(1)).toBe(1);
		expect(await repository.expireDue(10)).toBeGreaterThanOrEqual(1);
	});
});