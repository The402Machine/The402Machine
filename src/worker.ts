import postgres from "postgres";

import { loadConfig } from "./config.js";
import { startExpiryWorker } from "./expiry-worker.js";
import { PulseRepository } from "./pulse/pulse-repository.js";
import { CatchRepository } from "./storage/catch-repository.js";
import { WhisperRepository } from "./whisper/whisper-repository.js";

const config = loadConfig();
if (config.catch.databaseUrl === undefined) {
	throw new Error("DATABASE_URL is required for the CATCH expiry worker");
}

const database = postgres(config.catch.databaseUrl);
const catchRepository = new CatchRepository(database);
const whisperRepository = new WhisperRepository(database);
const pulseRepository = new PulseRepository(database);
const worker = startExpiryWorker([
	{ name: "CATCH", expireDue: (limit) => catchRepository.expireDueResources(limit) },
	{ name: "WHISPER", expireDue: (limit) => whisperRepository.expireDue(limit) },
	{ name: "PULSE", expireDue: (limit) => pulseRepository.expireDue(limit) },
], {
	onError: (jobName, error) => { console.error(`${jobName} expiry worker failed`, error); },
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
	console.info(`Expiry worker stopping after ${signal}`);
	await worker.stop();
	await database.end();
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

console.info("Expiry worker started");
