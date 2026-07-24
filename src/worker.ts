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
const worker = startExpiryWorker(new CatchRepository(database), {
	onError: (error) => { console.error("CATCH expiry worker failed", error); },
});
const whisperRepository = new WhisperRepository(database);
const pulseRepository = new PulseRepository(database);
const drainWhispers = async (): Promise<void> => {
	while (await whisperRepository.expireDue(100) === 100) {
		// Drain the complete overdue backlog before returning to the interval.
	}
};
const drainPulse = async (): Promise<void> => { while (await pulseRepository.expireDue(100) === 100) { /* drain overdue PULSE resources */ } };
const whisperTimer = setInterval(() => {
	void drainWhispers().catch((error: unknown) => { console.error("WHISPER expiry worker failed", error); });
	void drainPulse().catch((error: unknown) => { console.error("PULSE expiry worker failed", error); });
}, 30_000);
whisperTimer.unref();
void drainWhispers().catch((error: unknown) => { console.error("WHISPER expiry worker failed", error); });
void drainPulse().catch((error: unknown) => { console.error("PULSE expiry worker failed", error); });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
	console.info(`CATCH expiry worker stopping after ${signal}`);
	clearInterval(whisperTimer);
	await worker.stop();
	await database.end();
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

console.info("CATCH expiry worker started");
