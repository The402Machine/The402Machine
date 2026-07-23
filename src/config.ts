export type CatchConfig = {
	databaseUrl: string | undefined;
	tokenPepper: string | undefined;
	internalProvisioning: boolean;
	provisioningSecret: string | undefined;
	publicBaseUrl: string | undefined;
};

export type AppConfig = {
	host: string;
	port: number;
	logLevel: string;
	trustedProxy: string | undefined;
	catch: CatchConfig;
};

const parsePort = (value: string | undefined): number => {
	const port = Number(value ?? "4020");

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
};

const parseBoolean = (name: string, value: string | undefined, defaultValue: boolean): boolean => {
	if (value === undefined) return defaultValue;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
};

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
	const catchConfig: CatchConfig = {
		databaseUrl: environment.DATABASE_URL,
		tokenPepper: environment.CATCH_TOKEN_PEPPER,
		internalProvisioning: parseBoolean("CATCH_INTERNAL_PROVISIONING", environment.CATCH_INTERNAL_PROVISIONING, false),
		provisioningSecret: environment.CATCH_PROVISIONING_SECRET,
		publicBaseUrl: environment.PUBLIC_BASE_URL,
	};
	const hasDatabaseUrl = catchConfig.databaseUrl !== undefined && catchConfig.databaseUrl.length > 0;
	const hasTokenPepper = catchConfig.tokenPepper !== undefined && catchConfig.tokenPepper.length > 0;

	if (hasDatabaseUrl !== hasTokenPepper) {
		if (!hasDatabaseUrl) throw new Error("DATABASE_URL is required when CATCH_TOKEN_PEPPER is configured");
		throw new Error("CATCH_TOKEN_PEPPER is required when DATABASE_URL is configured");
	}

	if (catchConfig.internalProvisioning) {
		if (catchConfig.provisioningSecret === undefined || catchConfig.provisioningSecret.length === 0) throw new Error("CATCH_PROVISIONING_SECRET is required when CATCH_INTERNAL_PROVISIONING is enabled");
		if (catchConfig.tokenPepper === undefined || catchConfig.tokenPepper.length === 0) throw new Error("CATCH_TOKEN_PEPPER is required when CATCH_INTERNAL_PROVISIONING is enabled");
		if (catchConfig.databaseUrl === undefined || catchConfig.databaseUrl.length === 0) throw new Error("DATABASE_URL is required when CATCH_INTERNAL_PROVISIONING is enabled");
	}

	return {
		host: environment.HOST ?? "127.0.0.1",
		port: parsePort(environment.PORT),
		logLevel: environment.LOG_LEVEL ?? "info",
		trustedProxy: environment.TRUSTED_PROXY,
		catch: catchConfig,
	};
};
