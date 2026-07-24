import { randomBytes } from "node:crypto";

import postgres from "postgres";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { calculatePlanExpiry, CATCH_PLANS } from "./domain/catch-plans.js";
import { calculateWhisperExpiry, WHISPER_PLANS } from "./domain/whisper-plans.js";
import { lookupIpLocally } from "./ip-location.js";
import { LnbitsPaymentAdapter } from "./payment/lnbits-adapter.js";
import { PaymentRepository } from "./payment/payment-repository.js";
import { PaymentService } from "./payment/payment-service.js";
import { generateIngestToken, generateOwnerToken, hashToken } from "./security/tokens.js";
import { CatchRepository } from "./storage/catch-repository.js";
import { WhisperRepository } from "./whisper/whisper-repository.js";

const config = loadConfig();
const database = config.catch.databaseUrl === undefined ? undefined : postgres(config.catch.databaseUrl);
const catchRepository = database === undefined ? undefined : new CatchRepository(database);
const whisperRepository = database === undefined ? undefined : new WhisperRepository(database);
const catchOptions = catchRepository === undefined || config.catch.tokenPepper === undefined
	? undefined
	: {
		repository: catchRepository,
		tokenPepper: config.catch.tokenPepper,
		lookupIp: lookupIpLocally,
		provisioningEnabled: config.catch.internalProvisioning,
		...(config.catch.provisioningSecret === undefined ? {} : { provisioningSecret: config.catch.provisioningSecret }),
	};

const whisperOptions = whisperRepository === undefined || config.catch.tokenPepper === undefined
	? undefined
	: {
		repository: whisperRepository,
		tokenPepper: config.catch.tokenPepper,
		provisioningEnabled: config.catch.internalProvisioning,
		...(config.catch.provisioningSecret === undefined ? {} : { provisioningSecret: config.catch.provisioningSecret }),
	};
const paymentService = database === undefined || config.payment.provider !== "lnbits" || config.payment.apiUrl === undefined || config.payment.apiKey === undefined || config.payment.deliveryKey === undefined || config.catch.tokenPepper === undefined
	? undefined
	: new PaymentService(
		new PaymentRepository(database, config.payment.deliveryKey),
		new LnbitsPaymentAdapter({ baseUrl: config.payment.apiUrl, invoiceKey: config.payment.apiKey }),
		(order) => {
			const plan = CATCH_PLANS[order.planId];
			if (order.product === "whisper") {
				if (order.productPayload === null) throw new Error("WHISPER order has no ciphertext");
				const readToken = generateOwnerToken();
				return Promise.resolve({
					product: "whisper" as const,
					publicId: `whisper_${randomBytes(24).toString("base64url")}`,
					planId: order.planId,
					readTokenHash: hashToken("owner", readToken, config.catch.tokenPepper!),
					ciphertext: order.productPayload,
					readLimit: WHISPER_PLANS[order.planId].readLimit,
					readToken,
					expiresAt: calculateWhisperExpiry(order.planId, new Date()),
				});
			}
			const ownerToken = generateOwnerToken();
			const ingestToken = generateIngestToken();
			return Promise.resolve({
				product: "catch" as const,
				publicId: `catch_${randomBytes(24).toString("base64url")}`,
				planId: order.planId,
				ownerTokenHash: hashToken("owner", ownerToken, config.catch.tokenPepper!),
				ingestTokenHash: hashToken("ingest", ingestToken, config.catch.tokenPepper!),
				requestLimit: plan.requestLimit,
				storageLimitBytes: plan.storageLimitBytes,
				maxBytesPerRequest: plan.maxBytesPerRequest,
				expiresAt: calculatePlanExpiry(order.planId, new Date()),
				ownerToken,
				ingestToken,
			});
		},
	);
const app = buildApp({
	logger: {
		level: config.logLevel,
	},
	...(config.trustedProxy === undefined ? {} : { trustedProxy: config.trustedProxy }),
	...(catchOptions === undefined ? {} : { catch: catchOptions }),
	...(whisperOptions === undefined ? {} : { whisper: whisperOptions }),
	...(paymentService === undefined ? {} : { payment: paymentService }),
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
