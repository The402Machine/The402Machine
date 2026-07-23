export type AppConfig = {
	host: string;
	port: number;
	logLevel: string;
};

const parsePort = (value: string | undefined): number => {
	const port = Number(value ?? "4020");

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
};

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => ({
	host: environment.HOST ?? "127.0.0.1",
	port: parsePort(environment.PORT),
	logLevel: environment.LOG_LEVEL ?? "info",
});
