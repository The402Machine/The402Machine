import { execFileSync } from "node:child_process";

import postgres from "postgres";

export const POSTGRES_TEST_IMAGE = "postgres:17-alpine";

export type PostgresTestContainer = {
	name: string;
	databaseUrl: string;
	stop(): void;
};

type StartOptions = {
	name: string;
	password: string;
	database?: string;
	image?: string;
	timeoutMs?: number;
};

export function docker(...args: string[]): string {
	return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

export async function startPostgresTestContainer(options: StartOptions): Promise<PostgresTestContainer> {
	const database = options.database ?? "the402machine_test";
	const image = options.image ?? POSTGRES_TEST_IMAGE;
	removeContainer(options.name);
	docker(
		"run",
		"--detach",
		"--name",
		options.name,
		"--publish",
		"127.0.0.1::5432",
		"--env",
		`POSTGRES_PASSWORD=${options.password}`,
		"--env",
		`POSTGRES_DB=${database}`,
		image,
	);

	try {
		const port = docker("port", options.name, "5432/tcp").split(":").at(-1);
		if (port === undefined) throw new Error("Could not determine PostgreSQL test port");
		const databaseUrl = `postgresql://postgres:${encodeURIComponent(options.password)}@127.0.0.1:${port}/${database}`;
		await waitForPostgres(options.name, databaseUrl, options.timeoutMs ?? 30_000);
		return {
			name: options.name,
			databaseUrl,
			stop: () => removeContainer(options.name),
		};
	} catch (error: unknown) {
		const diagnostics = containerDiagnostics(options.name);
		removeContainer(options.name);
		const message = redactPostgresTestError(error instanceof Error ? error.message : String(error), options.password);
		throw new Error(`${message}\n${diagnostics}`, { cause: error });
	}
}

export function removeContainer(name: string): void {
	try {
		execFileSync("docker", ["rm", "--force", name], { encoding: "utf8", stdio: "pipe" });
	} catch {
		// The container may already have exited or been removed.
	}
}

async function waitForPostgres(containerName: string, databaseUrl: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let delayMs = 100;
	while (Date.now() < deadline) {
		const probe = postgres(databaseUrl, { max: 1, connect_timeout: 1 });
		try {
			await probe`select 1`;
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			delayMs = Math.min(1_000, Math.ceil(delayMs * 1.5));
		} finally {
			await probe.end().catch(() => undefined);
		}
	}
	throw new Error(`PostgreSQL test container ${containerName} did not become ready within ${timeoutMs}ms`);
}

function containerDiagnostics(name: string): string {
	const state = safeDocker("inspect", "--format", "status={{.State.Status}} exit={{.State.ExitCode}} error={{json .State.Error}} oom={{.State.OOMKilled}}", name);
	const logs = safeDocker("logs", "--tail", "120", name);
	return [`Docker state for ${name}:`, state || "[unavailable]", `Docker logs for ${name}:`, logs || "[unavailable]"].join("\n");
}

function safeDocker(...args: string[]): string {
	try {
		return docker(...args);
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function redactPostgresTestError(message: string, password: string): string {
	return message.replaceAll(password, "[REDACTED]").replace(/POSTGRES_PASSWORD=[^\s'"\]]+/gu, "POSTGRES_PASSWORD=[REDACTED]");
}
