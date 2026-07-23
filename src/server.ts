import postgres from "postgres";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CatchRepository } from "./storage/catch-repository.js";

const config = loadConfig();
const database = config.catch.databaseUrl === undefined ? undefined : postgres(config.catch.databaseUrl);
const catchOptions = database === undefined || config.catch.tokenPepper === undefined
	? undefined
	: {
		repository: new CatchRepository(database),
		tokenPepper: config.catch.tokenPepper,
		provisioningEnabled: config.catch.internalProvisioning,
		...(config.catch.provisioningSecret === undefined ? {} : { provisioningSecret: config.catch.provisioningSecret }),
	};
const app = buildApp({
	logger: {
		level: config.logLevel,
	},
	...(catchOptions === undefined ? {} : { catch: catchOptions }),
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
	app.log.info({ signal }, "shutting down");
	await app.close();
	await database?.end();
};

process.once("SIGINT", () => {
	void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});

try {
	await app.listen({ host: config.host, port: config.port });
} catch (error) {
	app.log.error(error);
	process.exitCode = 1;
}
