import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { calculatePlanExpiry, CATCH_PLANS } from "./domain/catch-plans.js";
import { PULSE_PLANS } from "./domain/pulse-plans.js";
import { calculateWhisperSchedule, isWhisperReadLimit, MAX_WHISPER_CIPHERTEXT_BYTES, WHISPER_PLANS } from "./domain/whisper-plans.js";
import { CATCH_PRICES_SATS, PULSE_PRICES_SATS, WHISPER_PRICES_SATS } from "./payment/payment-domain.js";
import { createL402Challenge, parseL402Authorization, verifyL402Authorization } from "./payment/l402-protocol.js";
import { createPaymentChallenge, createPaymentReceipt, parsePaymentAuthorization, paymentChallengeFingerprint, verifyPaymentCredential } from "./payment/payment-protocol.js";
import type { DispensedResource } from "./payment/payment-repository.js";
import type { PaymentQuote } from "./payment/payment-service.js";
import { ownerPulseStatus, parsePulseSettings, publicPulseStatus } from "./pulse/pulse-contract.js";
import type { AcceptPulseResult, PulseResource, PulseSettings } from "./pulse/pulse-repository.js";
import { verifyPulseToken } from "./security/pulse-tokens.js";
import { generateIngestToken, generateOwnerToken, hashToken, verifyToken } from "./security/tokens.js";
import type { AcceptEventInput, AcceptEventResult, CatchCredentialHashes, CatchEvent, CatchEventListOptions, CatchEventPage, CatchIpLocation, CatchResource, ProvisionInput } from "./storage/catch-repository.js";
import type { PlatformStats } from "./stats/stats-repository.js";
import type { CreateWhisperInput } from "./whisper/whisper-repository.js";

const MAX_INGEST_BYTES = Math.max(...Object.values(CATCH_PLANS).map((plan) => plan.maxBytesPerRequest));
const MAX_WHISPER_BYTES = MAX_WHISPER_CIPHERTEXT_BYTES;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const ALLOWED_CONTENT_TYPES = new Set(["application/json", "text/plain", "application/x-www-form-urlencoded"]);
const ALLOWED_HEADERS = new Set(["content-type", "user-agent", "x-request-id", "x-github-event", "x-github-delivery", "stripe-signature"]);
type RateLimitBucket = { count: number; resetsAt: number };

export interface CatchApiRepository {
	provision(input: ProvisionInput): Promise<CatchResource>;
	getResource(publicId: string): Promise<CatchResource | null>;
	getCredentialHashes(publicId: string): Promise<CatchCredentialHashes | null>;
	acceptEvent(input: AcceptEventInput): Promise<AcceptEventResult>;
	setEventIpLocation(publicId: string, eventId: string, location: CatchIpLocation): Promise<boolean>;
	listEvents(publicId: string, options: CatchEventListOptions): Promise<CatchEventPage>;
	deleteEvent(publicId: string, eventId: string): Promise<boolean>;
	destroy(publicId: string): Promise<boolean>;
}

export interface WhisperApiRepository {
	create(input: CreateWhisperInput): Promise<{ id: string; publicId: string }>;
	getCredentialHash(publicId: string): Promise<string | null>;
	getAvailability(publicId: string): Promise<{ state: "scheduled" | "available"; revealAt: Date; readCount: number; readLimit: number } | null>;
	consume(publicId: string): Promise<Buffer | null>;
}

export interface PulseApiRepository {
	getResource(publicId: string): Promise<PulseResource | null>;
	getPublicResource(publicStatusId: string): Promise<PulseResource | null>;
	getCredentialHashes(publicId: string): Promise<{ ownerTokenHash: string | null; pingTokenHash: string | null } | null>;
	acceptHeartbeat(publicId: string): Promise<AcceptPulseResult>;
	updateSettings(publicId: string, settings: PulseSettings): Promise<PulseResource | null>;
	destroy(publicId: string): Promise<boolean>;
}

type CatchAppOptions = {
	repository: CatchApiRepository;
	tokenPepper: string;
	lookupIp?: (ip: string) => Promise<CatchIpLocation | undefined>;
	provisioningEnabled?: boolean;
	provisioningSecret?: string;
};

type WhisperAppOptions = {
	repository: WhisperApiRepository;
	tokenPepper: string;
	provisioningEnabled?: boolean;
	provisioningSecret?: string;
};

type PulseAppOptions = { repository: PulseApiRepository; tokenPepper: string };

type PaymentAppOptions = {
	quote(input: { idempotencyKey: string; product: "catch" | "whisper" | "pulse"; planId: "spark" | "standard" | "long"; productPayload: Buffer | null; whisperReadLimit?: number | null; whisperRevealAt?: Date | null }): Promise<PaymentQuote>;
	fulfill(orderId: string): Promise<{ settled: false } | { settled: true; resource: DispensedResource }>;
	fulfillWithPreimage?(orderId: string, preimage: string): Promise<{ settled: false; reason: "invalid-preimage" | "unsettled" } | { settled: true; resource: DispensedResource }>;
	fulfillAgentPayment?(input: { challengeId: string; orderId: string; protocol: "payment" | "l402"; challengeFingerprint: string; paymentHash: string; expiresAt: Date; preimage: string }): Promise<{ settled: true; resource: DispensedResource } | { settled: false; reason: "invalid-preimage" | "unsettled" | "replayed" | "mismatch" | "expired" }>;
};

type PaymentProtocolOptions = { realm: string; secret: Buffer };
type StatsAppOptions = { getPublicStats(): Promise<PlatformStats>; recordPageView?(path: string): Promise<void> };

const PUBLIC_PAGE_PATHS = new Set(["/", "/api", "/demo", "/catch", "/whisper", "/pulse", "/pulse-public", "/stats", "/agents", "/install", "/changelog"]);

type BuildAppOptions = {
	logger?: boolean | object;
	trustedProxy?: string;
	catch?: CatchAppOptions;
	whisper?: WhisperAppOptions;
	pulse?: PulseAppOptions;
	payment?: PaymentAppOptions;
	paymentProtocols?: PaymentProtocolOptions;
	stats?: StatsAppOptions;
};

export const buildApp = (options: BuildAppOptions = {}): FastifyInstance => {
	const app = Fastify({
		logger: options.logger ?? false,
		bodyLimit: Math.max(MAX_INGEST_BYTES, MAX_WHISPER_BYTES),
		exposeHeadRoutes: false,
		logController: new LogController({ disableRequestLogging: true }),
		trustProxy: options.trustedProxy ?? false,
	});
	if (options.whisper !== undefined || options.payment !== undefined) {
		app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
	}
	if (options.payment !== undefined) {
		app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
	}

	void app.register(helmet, {
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"], fontSrc: ["'self'", "https://fonts.gstatic.com"], styleSrc: ["'self'", "https://fonts.googleapis.com"], imgSrc: ["'self'", "data:"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
			},
		},
		crossOriginEmbedderPolicy: false,
	});
	void app.register(fastifyStatic, { root: join(import.meta.dirname, "..", "public"), index: "index.html", extensions: ["html"], cacheControl: true, maxAge: "1h" });
	app.get("/health", () => ({ service: "the402machine", status: "ok" }));
	const stats = options.stats;
	const recordPageView = stats?.recordPageView?.bind(stats);
	if (recordPageView !== undefined) app.addHook("onResponse", (request) => {
		const path = request.url.split("?", 1)[0] ?? "";
		if (request.method === "GET" && PUBLIC_PAGE_PATHS.has(path)) {
			void recordPageView(path).catch((error: unknown) => request.log.error({ err: error }, "page view counter unavailable"));
		}
	});
	if (stats !== undefined) app.get("/api/stats", async (request, reply) => {
		try {
			return reply.header("Cache-Control", "public, max-age=30").send(await stats.getPublicStats());
		} catch (error) {
			request.log.error({ err: error }, "public stats unavailable");
			return reply.header("Cache-Control", "no-store").code(503).send({ error: "stats unavailable" });
		}
	});

	if (options.catch !== undefined) registerCatchRoutes(app, options.catch);
	if (options.whisper !== undefined) registerWhisperRoutes(app, options.whisper);
	if (options.pulse !== undefined) registerPulseRoutes(app, options.pulse);
	if (options.payment !== undefined) registerPaymentRoutes(app, options.payment, options.paymentProtocols);
	return app;
};

function registerPaymentRoutes(app: FastifyInstance, payment: PaymentAppOptions, protocols?: PaymentProtocolOptions): void {
	const quoteRateLimits = new Map<string, RateLimitBucket>();
	const verificationRateLimits = new Map<string, RateLimitBucket>();
	app.post<{ Body: { planId?: unknown } }>("/api/payments/catch", async (request, reply) => {
		if (!consumeRateLimit(quoteRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
		const idempotencyKey = request.headers["idempotency-key"];
		const planId = Buffer.isBuffer(request.body) ? parsePaymentPlan(request.body) : request.body?.planId;
		if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid idempotency key" });
		if (!isPlanId(planId) || !CATCH_PLANS[planId].available) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid plan" });
		const quote = await payment.quote({ idempotencyKey, product: "catch", planId, productPayload: null });
		return paymentProtocolResponse(request, reply, payment, protocols, quote, paymentRequestBody(request));
	});

	app.post("/api/payments/whisper", async (request, reply) => {
		if (!consumeRateLimit(quoteRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
		const idempotencyKey = request.headers["idempotency-key"];
		const planId = request.headers["x-whisper-plan"];
		const requestedReadLimit = request.headers["x-whisper-read-limit"];
		const requestedRevealAt = request.headers["x-whisper-reveal-at"];
		if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid idempotency key" });
		if (!isPlanId(planId) || !WHISPER_PLANS[planId].available) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid plan" });
		const whisperReadLimit = requestedReadLimit === undefined ? WHISPER_PLANS[planId].readLimit : Number(requestedReadLimit);
		if (!isWhisperReadLimit(planId, whisperReadLimit)) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid read limit" });
		let whisperRevealAt: Date | null = null;
		if (requestedRevealAt !== undefined) {
			if (typeof requestedRevealAt !== "string") return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid reveal date" });
			whisperRevealAt = new Date(requestedRevealAt);
			try { calculateWhisperSchedule(planId, new Date(), whisperRevealAt); }
			catch { return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid reveal date" }); }
		}
		if (normalizedContentType(request.headers["content-type"]) !== "application/octet-stream" || !Buffer.isBuffer(request.body) || request.body.byteLength < 30 || request.body.byteLength > WHISPER_PLANS[planId].maxCiphertextBytes) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid ciphertext" });
		const quote = await payment.quote({ idempotencyKey, product: "whisper", planId, productPayload: request.body, whisperReadLimit, whisperRevealAt });
		return paymentProtocolResponse(request, reply, payment, protocols, quote, request.body);
	});

	app.post<{ Body: { planId?: unknown } }>("/api/payments/pulse", async (request, reply) => {
		if (!consumeRateLimit(quoteRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
		const idempotencyKey = request.headers["idempotency-key"];
		const planId = Buffer.isBuffer(request.body) ? parsePaymentPlan(request.body) : request.body?.planId;
		if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid idempotency key" });
		if (!isPlanId(planId) || !PULSE_PLANS[planId].available) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid plan" });
		const quote = await payment.quote({ idempotencyKey, product: "pulse", planId, productPayload: null });
		return paymentProtocolResponse(request, reply, payment, protocols, quote, paymentRequestBody(request));
	});

	app.get<{ Params: { orderId: string } }>("/api/payments/:orderId", async (request, reply) => {
		if (!consumeRateLimit(verificationRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		const result = await payment.fulfill(request.params.orderId);
		if (!result.settled) return reply.header("Cache-Control", "no-store").code(402).send(result);
		return reply.header("Cache-Control", "no-store").send({ settled: true, resource: publicDispensedResource(result.resource) });
	});

	app.get("/api/catalog", async (_request, reply) => reply.header("Cache-Control", "public, max-age=60").send(paymentCatalogue()));
}

async function paymentProtocolResponse(request: FastifyRequest, reply: FastifyReply, payment: PaymentAppOptions, protocols: PaymentProtocolOptions | undefined, quote: PaymentQuote, body: Buffer): Promise<unknown> {
	const selectedProtocol = request.headers["x-payment-protocol"];
	if (protocols === undefined || (selectedProtocol !== "payment" && selectedProtocol !== "l402")) return reply.header("Cache-Control", "no-store").code(402).send(quote);
	const expiresAt = new Date(quote.expiresAt);
	if (selectedProtocol === "l402") return l402ProtocolResponse(request, reply, payment, protocols, quote, body, expiresAt);
	const challenge = createPaymentChallenge({ quote, realm: protocols.realm, method: request.method, path: request.routeOptions.url ?? request.url, body, expiresAt, secret: protocols.secret });
	const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
	if (authorization === undefined) return paymentChallenge(reply, challenge.header, quote, expiresAt);
	const verification = verifyPaymentCredential({ authorization, expected: challenge.parameters, body, secret: protocols.secret, now: new Date() });
	if (!verification.valid) return paymentProblem(reply, challenge.header, verification.reason);
	const credential = parsePaymentAuthorization(authorization);
	if (credential === null || payment.fulfillAgentPayment === undefined) return paymentProblem(reply, challenge.header, "malformed-credential");
	const challengeId = challenge.parameters.id;
	const result = await payment.fulfillAgentPayment({ challengeId, orderId: quote.orderId, protocol: "payment", challengeFingerprint: paymentChallengeFingerprint(challenge.parameters), paymentHash: verification.paymentHash, expiresAt, preimage: credential.preimage });
	if (!result.settled) return paymentProblem(reply, challenge.header, result.reason === "invalid-preimage" ? "invalid-preimage" : result.reason === "expired" ? "expired-invoice" : "unknown-challenge");
	return reply.header("Cache-Control", "private, no-store").header("Payment-Receipt", createPaymentReceipt({ challengeId: challenge.parameters.id, paymentHash: verification.paymentHash, settledAt: new Date() })).send({ settled: true, resource: publicDispensedResource(result.resource) });
}

async function l402ProtocolResponse(request: FastifyRequest, reply: FastifyReply, payment: PaymentAppOptions, protocols: PaymentProtocolOptions, quote: PaymentQuote, body: Buffer, expiresAt: Date): Promise<unknown> {
	const path = request.routeOptions.url ?? request.url;
	const challenge = createL402Challenge({ paymentHash: quote.paymentHash, bolt11: quote.bolt11, rootKey: protocols.secret, tokenId: createHash("sha256").update(`l402:${quote.orderId}`, "utf8").digest(), location: protocols.realm, product: quote.product, planId: quote.planId, method: request.method, path, body, expiresAt });
	const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
	if (authorization === undefined) return reply.header("Cache-Control", "no-store").header("WWW-Authenticate", challenge.header).code(402).send({ protocol: "l402", orderId: quote.orderId, amountSats: quote.amountSats, expiresAt: expiresAt.toISOString() });
	const verification = verifyL402Authorization({ authorization, rootKey: protocols.secret, expectedPaymentHash: quote.paymentHash, product: quote.product, planId: quote.planId, method: request.method, path, body, now: new Date() });
	if (!verification.valid) return reply.header("Cache-Control", "no-store").header("WWW-Authenticate", challenge.header).code(401).send({ error: "invalid L402 credential" });
	const credential = parseL402Authorization(authorization);
	if (credential === null || payment.fulfillAgentPayment === undefined) return reply.header("Cache-Control", "no-store").header("WWW-Authenticate", challenge.header).code(401).send({ error: "invalid L402 credential" });
	const challengeId = createHash("sha256").update(challenge.macaroon, "utf8").digest("base64url");
	const result = await payment.fulfillAgentPayment({ challengeId, orderId: quote.orderId, protocol: "l402", challengeFingerprint: createHash("sha256").update(challenge.header, "utf8").digest("hex"), paymentHash: verification.paymentHash, expiresAt, preimage: credential.preimage });
	if (!result.settled) return reply.header("Cache-Control", "no-store").header("WWW-Authenticate", challenge.header).code(401).send({ error: "invalid L402 credential" });
	return reply.header("Cache-Control", "private, no-store").send({ settled: true, resource: publicDispensedResource(result.resource) });
}

function paymentChallenge(reply: FastifyReply, header: string, quote: PaymentQuote, expiresAt: Date): unknown {
	return reply.header("Cache-Control", "no-store").header("WWW-Authenticate", header).code(402).send({ protocol: "payment", method: "lightning", intent: "charge", orderId: quote.orderId, amountSats: quote.amountSats, expiresAt: expiresAt.toISOString() });
}

function paymentProblem(reply: FastifyReply, header: string, reason: "malformed-credential" | "invalid-challenge" | "invalid-preimage" | "expired-invoice" | "unknown-challenge"): unknown {
	const titles = { "malformed-credential": "Malformed Credential", "invalid-challenge": "Invalid Challenge", "invalid-preimage": "Invalid Preimage", "expired-invoice": "Expired Invoice", "unknown-challenge": "Unknown Challenge" };
	return reply.header("Cache-Control", "no-store").header("WWW-Authenticate", header).type("application/problem+json").code(402).send({ type: `https://paymentauth.org/problems/lightning/${reason}`, title: titles[reason], status: 402 });
}

function paymentRequestBody(request: FastifyRequest): Buffer {
	if (Buffer.isBuffer(request.body)) return request.body;
	return Buffer.from(JSON.stringify(request.body ?? {}), "utf8");
}

function publicDispensedResource(resource: DispensedResource): object {
	return resource.product === "catch"
		? { product: "catch", publicId: resource.publicId, ownerToken: resource.ownerToken, ingestToken: resource.ingestToken, expiresAt: resource.expiresAt.toISOString() }
		: resource.product === "whisper"
			? { product: "whisper", publicId: resource.publicId, readToken: resource.readToken, expiresAt: resource.expiresAt.toISOString() }
			: { product: "pulse", publicId: resource.publicId, ownerToken: resource.ownerToken, pingToken: resource.pingToken, expiresAt: resource.expiresAt.toISOString() };
}

function paymentCatalogue() {
	return {
		checkoutEnabled: true,
		currency: "sat",
		products: {
			catch: {
				description: "Private inbound-only webhook inbox with fixed quotas.",
				plans: [
					catchPlan("spark", "4h 02m", "Quick tests and short-lived integrations"),
					catchPlan("standard", "40d 02h", "Temporary projects and real workflows"),
					catchPlan("long", "4 months + 2 days", "Long-running missions with a hard stop"),
				],
			},
			whisper: {
				description: "Client-encrypted message with a fixed read allowance and expiry.",
				clientEncryption: "AES-256-GCM",
				plans: [
					whisperPlan("spark", "7 days", "Short handoff"),
					whisperPlan("standard", "42 days", "Patient delivery window"),
					whisperPlan("long", "402 days", "Long-term dead drop"),
				],
			},
			pulse: {
				description: "Temporary heartbeat monitor with a fixed lifetime quota, private owner portal, and optional public status page.",
				plans: [
					pulsePlan("spark", "4d 02h", "Short jobs and compact experiments"),
					pulsePlan("standard", "42 days", "Production cron jobs and automations"),
					pulsePlan("long", "402 days", "Long-running infrastructure"),
				],
			},
		},
	};
}

function catchPlan(planId: "spark" | "standard" | "long", durationLabel: string, bestFor: string) {
	const plan = CATCH_PLANS[planId];
	return { planId, priceSats: CATCH_PRICES_SATS[planId], durationLabel, bestFor, requestLimit: plan.requestLimit, storageLimitBytes: plan.storageLimitBytes, maxBytesPerRequest: plan.maxBytesPerRequest, available: plan.available };
}

function whisperPlan(planId: "spark" | "standard" | "long", durationLabel: string, bestFor: string) {
	const plan = WHISPER_PLANS[planId];
	return { planId, priceSats: WHISPER_PRICES_SATS[planId], durationLabel, bestFor, readLimit: plan.readLimit, maxCiphertextBytes: plan.maxCiphertextBytes, available: plan.available };
}

function pulsePlan(planId: "spark" | "standard" | "long", durationLabel: string, bestFor: string) {
	const plan = PULSE_PLANS[planId];
	return { planId, priceSats: PULSE_PRICES_SATS[planId], durationLabel, bestFor, heartbeatLimit: plan.heartbeatLimit, suggestedCadenceSeconds: plan.suggestedCadenceSeconds, minimumGraceSeconds: plan.minimumGraceSeconds, available: plan.available };
}

function parsePaymentPlan(body: Buffer): unknown {
	try {
		const parsed: unknown = JSON.parse(body.toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as { planId?: unknown }).planId : undefined;
	} catch {
		return undefined;
	}
}

function isPlanId(value: unknown): value is "spark" | "standard" | "long" {
	return value === "spark" || value === "standard" || value === "long";
}

function registerWhisperRoutes(app: FastifyInstance, options: WhisperAppOptions): void {
	const provisioningRateLimits = new Map<string, RateLimitBucket>();
	const readRateLimits = new Map<string, RateLimitBucket>();
	if (options.provisioningEnabled === true && nonEmpty(options.provisioningSecret)) {
		const provisioningSecret = options.provisioningSecret;
		app.post("/internal/whisper/provision", async (request, reply) => {
			if (!consumeRateLimit(provisioningRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
			if (!safeSecretMatches(bearerToken(request), provisioningSecret)) return unauthorized(reply);
			if (normalizedContentType(request.headers["content-type"]) !== "application/octet-stream") return reply.code(400).send({ error: "invalid request" });
			if (!Buffer.isBuffer(request.body) || request.body.byteLength < 1 || request.body.byteLength > MAX_WHISPER_BYTES) return reply.code(400).send({ error: "invalid request" });
			const planId = request.headers["x-whisper-plan"];
			if (!isPlanId(planId) || !WHISPER_PLANS[planId].available) return reply.code(400).send({ error: "invalid plan" });
			const plan = WHISPER_PLANS[planId];
			const readToken = generateOwnerToken();
			const publicId = `whisper_${randomBytes(24).toString("base64url")}`;
			const { revealAt, expiresAt } = calculateWhisperSchedule(planId, new Date());
			await options.repository.create({ publicId, planId, readTokenHash: hashToken("owner", readToken, options.tokenPepper), ciphertext: request.body, readLimit: plan.readLimit, revealAt, expiresAt });
			return reply.header("Cache-Control", "no-store").code(201).send({ publicId, readToken, expiresAt: expiresAt.toISOString(), readLimit: plan.readLimit, maxBytes: plan.maxCiphertextBytes });
		});
	}

	app.get<{ Params: { publicId: string } }>("/w/:publicId", async (request, reply) => {
		if (!consumeRateLimit(readRateLimits, `${request.ip}:${request.params.publicId}`, 30, 60_000)) return rateLimited(reply);
		const credentialHash = await options.repository.getCredentialHash(request.params.publicId);
		if (credentialHash === null || !verifyToken("owner", bearerToken(request) ?? "", credentialHash, options.tokenPepper)) {
			return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		}
		const availability = await options.repository.getAvailability(request.params.publicId);
		if (availability === null) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		if (availability.state === "scheduled") {
			const retryAfter = Math.max(1, Math.ceil((availability.revealAt.getTime() - Date.now()) / 1_000));
			return reply.header("Cache-Control", "no-store").header("Retry-After", String(retryAfter)).code(425).send({ error: "not revealed", revealAt: availability.revealAt.toISOString() });
		}
		const ciphertext = await options.repository.consume(request.params.publicId);
		if (ciphertext === null) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		return reply.header("Cache-Control", "no-store").type("application/octet-stream").send(ciphertext);
	});
}

function registerPulseRoutes(app: FastifyInstance, options: PulseAppOptions): void {
	const heartbeatRateLimits = new Map<string, RateLimitBucket>();
	const ownerRateLimits = new Map<string, RateLimitBucket>();
	app.post<{ Params: { publicId: string } }>("/p/:publicId", async (request, reply) => {
		if (!consumeRateLimit(heartbeatRateLimits, `${request.ip}:${request.params.publicId}`, 120, 60_000)) return rateLimited(reply);
		const credentials = await options.repository.getCredentialHashes(request.params.publicId);
		if (credentials?.pingTokenHash === null || credentials === null || !verifyPulseToken("ping", bearerToken(request) ?? "", credentials.pingTokenHash, options.tokenPepper)) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		const result = await options.repository.acceptHeartbeat(request.params.publicId);
		return result.accepted ? reply.header("Cache-Control", "no-store").code(204).send() : reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
	});
	app.get<{ Params: { publicStatusId: string } }>("/api/pulse/public/:publicStatusId", async (request, reply) => {
		const resource = await options.repository.getPublicResource(request.params.publicStatusId);
		if (resource === null || !resource.publicStatusEnabled || resource.expiresAt.getTime() <= Date.now() || resource.status === "expired" || resource.status === "manually_destroyed") return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		return reply.header("Cache-Control", "no-store").send(publicPulseStatus(resource));
	});
	app.get<{ Params: { publicId: string } }>("/api/pulse/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizePulseOwner(request, options)) return unauthorized(reply);
		const resource = await options.repository.getResource(request.params.publicId);
		return resource === null ? reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" }) : reply.header("Cache-Control", "no-store").send(ownerPulseStatus(resource));
	});
	app.patch<{ Params: { publicId: string }; Body: Partial<PulseSettings> }>("/api/pulse/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizePulseOwner(request, options)) return unauthorized(reply);
		const current = await options.repository.getResource(request.params.publicId);
		if (current === null) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		const settings = parsePulseSettings(request.body, current);
		if (settings === null) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid settings" });
		const updated = await options.repository.updateSettings(request.params.publicId, settings);
		return updated === null ? reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" }) : reply.header("Cache-Control", "no-store").send(ownerPulseStatus(updated));
	});
	app.delete<{ Params: { publicId: string } }>("/api/pulse/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizePulseOwner(request, options)) return unauthorized(reply);
		return await options.repository.destroy(request.params.publicId) ? reply.header("Cache-Control", "no-store").code(204).send() : reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
	});
}

async function authorizePulseOwner(request: FastifyRequest<{ Params: { publicId: string } }>, options: PulseAppOptions): Promise<boolean> {
	const credentials = await options.repository.getCredentialHashes(request.params.publicId);
	return credentials?.ownerTokenHash !== null && credentials !== null && verifyPulseToken("owner", bearerToken(request) ?? "", credentials.ownerTokenHash, options.tokenPepper);
}
function registerCatchRoutes(app: FastifyInstance, options: CatchAppOptions): void {
	const ingestionRateLimits = new Map<string, RateLimitBucket>();
	const provisioningRateLimits = new Map<string, RateLimitBucket>();
	const ownerRateLimits = new Map<string, RateLimitBucket>();
	for (const contentType of ALLOWED_CONTENT_TYPES) {
		if (app.hasContentTypeParser(contentType)) app.removeContentTypeParser(contentType);
		app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
	}

	if (options.provisioningEnabled === true && nonEmpty(options.provisioningSecret)) {
		const provisioningSecret = options.provisioningSecret;
		app.post<{ Body: { planId?: unknown } }>("/internal/catch/provision", async (request, reply) => {
			if (!consumeRateLimit(provisioningRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
			if (!safeSecretMatches(bearerToken(request), provisioningSecret)) return reply.code(401).send({ error: "unauthorized" });
			const planId = provisionPlanId(request.body);
			if (!isPlanId(planId)) return reply.code(400).send({ error: "invalid plan" });
			const plan = CATCH_PLANS[planId];
			if (!plan.available) return reply.code(400).send({ error: "invalid plan" });

			const ownerToken = generateOwnerToken();
			const ingestToken = generateIngestToken();
			const publicId = `catch_${randomBytes(24).toString("base64url")}`;
			const expiresAt = calculatePlanExpiry(planId, new Date());
			await options.repository.provision({
				publicId, planId, expiresAt, requestLimit: plan.requestLimit, storageLimitBytes: plan.storageLimitBytes, maxBytesPerRequest: plan.maxBytesPerRequest,
				ownerTokenHash: hashToken("owner", ownerToken, options.tokenPepper), ingestTokenHash: hashToken("ingest", ingestToken, options.tokenPepper),
			});
			return reply.header("Cache-Control", "no-store").code(201).send({ publicId, ownerToken, ingestToken, expiresAt: expiresAt.toISOString() });
		});
	}

	const ingestHandler = async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: Parameters<Parameters<FastifyInstance["route"]>[0]["handler"]>[1]) => {
		if (!consumeRateLimit(ingestionRateLimits, `${request.ip}:${request.params.publicId}`, 60, 60_000)) return rateLimited(reply);
		const contentType = normalizedContentType(request.headers["content-type"]) ?? "text/plain";
		if (!ALLOWED_CONTENT_TYPES.has(contentType) || !identityEncoding(request.headers["content-encoding"])) return reply.code(400).send({ error: "invalid request" });
		const credentials = await options.repository.getCredentialHashes(request.params.publicId);
		if (credentials === null || credentials.ingestTokenHash === null) return reply.code(401).send({ error: "unauthorized" });
		const authenticated = verifyToken("ingest", bearerToken(request) ?? "", credentials.ingestTokenHash, options.tokenPepper);
		const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
		if (body.byteLength > MAX_INGEST_BYTES) return reply.code(400).send({ error: "invalid request" });
		const sourceIp = request.ip;
		const accepted = await options.repository.acceptEvent({ publicId: request.params.publicId, method: request.method, authenticated, sourceIp, contentType, headers: filteredHeaders(request), body });
		if (!accepted.accepted) return reply.code(400).send({ error: "invalid request" });
		if (options.lookupIp !== undefined) void enrichEventIp(options, request.params.publicId, accepted.eventId, sourceIp);
		return reply.code(204).send();
	};
	for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) app.route({ method, url: "/c/:publicId", handler: ingestHandler });

	app.get<{ Params: { publicId: string } }>("/api/catch/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizeOwner(request, options)) return unauthorized(reply);
		const resource = await options.repository.getResource(request.params.publicId);
		if (resource === null) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		return reply.header("Cache-Control", "no-store").send(resourceStatus(resource));
	});

	app.get<{ Params: { publicId: string }; Querystring: { limit?: string; cursor?: string; access?: string; method?: string; contentType?: string; q?: string } }>("/api/catch/:publicId/events", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizeOwner(request, options)) return unauthorized(reply);
		const page = await options.repository.listEvents(request.params.publicId, parseEventOptions(request.query));
		return reply.header("Cache-Control", "no-store").send({ events: page.events.map(eventResponse), nextCursor: page.nextCursor });
	});


	app.delete<{ Params: { publicId: string; eventId: string } }>("/api/catch/:publicId/events/:eventId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizeOwner(request, options)) return unauthorized(reply);
		const deleted = await options.repository.deleteEvent(request.params.publicId, request.params.eventId);
		return deleted ? reply.header("Cache-Control", "no-store").code(204).send() : reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
	});

	app.delete<{ Params: { publicId: string } }>("/api/catch/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizeOwner(request, options)) return unauthorized(reply);
		const destroyed = await options.repository.destroy(request.params.publicId);
		return destroyed ? reply.header("Cache-Control", "no-store").code(204).send() : reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
	});
}

async function authorizeOwner(request: FastifyRequest<{ Params: { publicId: string } }>, options: CatchAppOptions): Promise<boolean> {
	const credentials = await options.repository.getCredentialHashes(request.params.publicId);
	return credentials?.ownerTokenHash !== null && credentials !== null && verifyToken("owner", bearerToken(request) ?? "", credentials.ownerTokenHash, options.tokenPepper);
}

function unauthorized(reply: { header(name: string, value: string): typeof reply; code(statusCode: number): typeof reply; send(payload: object): unknown }): unknown {
	return reply.header("Cache-Control", "no-store").code(401).send({ error: "unauthorized" });
}

function rateLimited(reply: { header(name: string, value: string): typeof reply; code(statusCode: number): typeof reply; send(payload: object): unknown }): unknown {
	return reply.header("Retry-After", "60").code(429).send({ error: "too many requests" });
}

function consumeRateLimit(buckets: Map<string, RateLimitBucket>, key: string, max: number, windowMs: number): boolean {
	const now = Date.now();
	if (buckets.size >= MAX_RATE_LIMIT_BUCKETS && !buckets.has(key)) {
		for (const [bucketKey, bucket] of buckets) {
			if (now >= bucket.resetsAt) buckets.delete(bucketKey);
		}
		if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
			const oldestKey = buckets.keys().next().value;
			if (oldestKey !== undefined) buckets.delete(oldestKey);
		}
	}
	const current = buckets.get(key);
	if (current === undefined || now >= current.resetsAt) {
		buckets.set(key, { count: 1, resetsAt: now + windowMs });
		return true;
	}
	if (current.count >= max) return false;
	current.count += 1;
	return true;
}

function bearerToken(request: FastifyRequest): string | undefined {
	const authorization = request.headers.authorization;
	if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
	const token = authorization.slice("Bearer ".length);
	return token.length > 0 ? token : undefined;
}

function safeSecretMatches(actual: string | undefined, expected: string): boolean {
	if (actual === undefined) return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function normalizedContentType(value: string | undefined): string | undefined { return value?.split(";", 1)[0]?.trim().toLowerCase(); }
function identityEncoding(value: string | undefined): boolean { return value === undefined || value.toLowerCase() === "identity"; }
function nonEmpty(value: string | undefined): value is string { return value !== undefined && value.length > 0; }
function filteredHeaders(request: FastifyRequest): Record<string, string> {
	return Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) => ALLOWED_HEADERS.has(name) && typeof value === "string" ? [[name, value]] : []));
}
function parseLimit(value: string | undefined): number { const parsed = Number(value ?? "50"); return Number.isInteger(parsed) ? Math.max(1, Math.min(50, parsed)) : 50; }
function parseEventOptions(query: { limit?: string; cursor?: string; access?: string; method?: string; contentType?: string; q?: string }): CatchEventListOptions {
	const cursor = Number(query.cursor);
	return {
		limit: parseLimit(query.limit),
		...(Number.isInteger(cursor) && cursor > 0 ? { cursor } : {}),
		...(query.access === "public" || query.access === "authenticated" ? { access: query.access } : {}),
		...(typeof query.method === "string" && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(query.method.toUpperCase()) ? { method: query.method.toUpperCase() } : {}),
		...(typeof query.contentType === "string" && query.contentType.length > 0 ? { contentType: query.contentType.slice(0, 120) } : {}),
		...(typeof query.q === "string" && query.q.trim().length > 0 ? { query: query.q.trim().slice(0, 120) } : {}),
	};
}
function resourceStatus(resource: CatchResource): object {
	return { publicId: resource.publicId, planId: resource.planId, status: resource.status, requestLimit: resource.requestLimit, storageLimitBytes: resource.storageLimitBytes, maxBytesPerRequest: resource.maxBytesPerRequest, acceptedRequestCount: resource.acceptedRequestCount, storedBytes: resource.storedBytes, createdAt: resource.createdAt.toISOString(), expiresAt: resource.expiresAt.toISOString() };
}
function eventResponse(event: CatchEvent): object {
	return { id: event.id, sequenceNumber: event.sequenceNumber, method: event.method, authenticated: event.authenticated, access: event.authenticated ? "authenticated" : "public", sourceIp: event.sourceIp, ipLocation: event.ipLocation, contentType: event.contentType, headers: event.headers, body: event.body.toString("base64"), bodyEncoding: "base64", receivedAt: event.receivedAt.toISOString() };
}

async function enrichEventIp(options: CatchAppOptions, publicId: string, eventId: string, ip: string): Promise<void> {
	try {
		const location = await options.lookupIp?.(ip);
		if (location !== undefined) await options.repository.setEventIpLocation(publicId, eventId, location);
	} catch {
		// Geolocation is best-effort and must never delay or reject ingestion.
	}
}

function provisionPlanId(body: unknown): unknown {
	if (Buffer.isBuffer(body)) {
		const parsed = parseJsonBuffer(body);
		return typeof parsed === "object" && parsed !== null ? (parsed as { planId?: unknown }).planId : undefined;
	}
	if (typeof body === "object" && body !== null) return (body as { planId?: unknown }).planId;
	return undefined;
}

function parseJsonBuffer(body: Buffer): unknown {
	try { return JSON.parse(body.toString("utf8")); } catch { return null; }
}
