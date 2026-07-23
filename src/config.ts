export type CatchConfig = {
	databaseUrl: string | undefined;
	tokenPepper: string | undefined;
	internalProvisioning: boolean;
	provisioningSecret: string | undefined;
	publicBaseUrl: string | undefined;
};

export type PaymentConfig = {
	provider: "disabled" | "lnbits";
	apiUrl: string | undefined;
	apiKey: string | undefined;
	deliveryKey: string | undefined;
};

export type AppConfig = {
	host: string;
	port: number;
	logLevel: string;
	trustedProxy: string | undefined;
	catch: CatchConfig;
	payment: PaymentConfig;
};

const parsePort = (value: string | undefined): number => {
	const port = Number(value ?? "4020");
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535");
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
	const hasDatabaseUrl = nonEmpty(catchConfig.databaseUrl);
	const hasTokenPepper = nonEmpty(catchConfig.tokenPepper);
	if (hasDatabaseUrl !== hasTokenPepper) {
		if (!hasDatabaseUrl) throw new Error("DATABASE_URL is required when CATCH_TOKEN_PEPPER is configured");
		throw new Error("CATCH_TOKEN_PEPPER is required when DATABASE_URL is configured");
	}
	if (catchConfig.internalProvisioning) {
		if (!nonEmpty(catchConfig.provisioningSecret)) throw new Error("CATCH_PROVISIONING_SECRET is required when CATCH_INTERNAL_PROVISIONING is enabled");
		if (!hasTokenPepper) throw new Error("CATCH_TOKEN_PEPPER is required when CATCH_INTERNAL_PROVISIONING is enabled");
		if (!hasDatabaseUrl) throw new Error("DATABASE_URL is required when CATCH_INTERNAL_PROVISIONING is enabled");
	}

	const provider = environment.PAYMENT_PROVIDER === "lnbits" ? "lnbits" : "disabled";
	const payment: PaymentConfig = {
		provider,
		apiUrl: environment.PAYMENT_API_URL,
		apiKey: environment.PAYMENT_API_KEY,
		deliveryKey: environment.PAYMENT_DELIVERY_KEY,
	};
	if (payment.provider === "lnbits") {
		if (!nonEmpty(payment.apiUrl)) throw new Error("PAYMENT_API_URL is required when LNbits payments are enabled");
		if (!isPrivatePaymentBridgeUrl(payment.apiUrl)) throw new Error("PAYMENT_API_URL must use the private payment bridge");
		if (!nonEmpty(payment.apiKey)) throw new Error("PAYMENT_API_KEY is required when LNbits payments are enabled");
		if (!nonEmpty(payment.deliveryKey) || Buffer.from(payment.deliveryKey, "base64url").byteLength !== 32) throw new Error("PAYMENT_DELIVERY_KEY must contain 32 base64url-encoded bytes");
		if (!hasDatabaseUrl || !hasTokenPepper) throw new Error("DATABASE_URL and CATCH_TOKEN_PEPPER are required when LNbits payments are enabled");
	}

	return {
		host: environment.HOST ?? "127.0.0.1",
		port: parsePort(environment.PORT),
		logLevel: environment.LOG_LEVEL ?? "info",
		trustedProxy: environment.TRUSTED_PROXY,
		catch: catchConfig,
		payment,
	};
};

function nonEmpty(value: string | undefined): value is string {
	return value !== undefined && value.length > 0;
}

function isPrivatePaymentBridgeUrl(value: string): boolean {
	try {
			const url = new URL(value);
			return url.protocol === "http:" && (
				url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" ||
				(url.hostname === "172.30.240.1" && url.port === "2180")
			);
	} catch {
		return false;
	}
}
