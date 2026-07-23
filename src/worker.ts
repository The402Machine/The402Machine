import postgres from "postgres";

import { loadConfig } from "./config.js";
import { startExpiryWorker } from "./expiry-worker.js";
import { CatchRepository } from "./storage/catch-repository.js";

const config = loadConfig();
if (config.catch.databaseUrl === undefined) {
	throw new Error("DATABASE_URL is required for the CATCH expiry worker");
}

const database = postgres(config.catch.databaseUrl);
const worker = startExpiryWorker(new CatchRepository(database), {
	onError: (error) => { console.error("CATCH expiry worker failed", error); },
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
	console.info(`CATCH expiry worker stopping after ${signal}`);
	await worker.stop();
	await database.end();
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

console.info("CATCH expiry worker started");
