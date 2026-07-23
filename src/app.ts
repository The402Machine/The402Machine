import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";

import { calculatePlanExpiry, CATCH_PLANS } from "./domain/catch-plans.js";
import { calculateWhisperExpiry, WHISPER_PLANS } from "./domain/whisper-plans.js";
import { CATCH_PRICES_SATS, WHISPER_PRICES_SATS } from "./payment/payment-domain.js";
import type { DispensedResource } from "./payment/payment-repository.js";
import type { PaymentQuote } from "./payment/payment-service.js";
import { generateIngestToken, generateOwnerToken, hashToken, verifyToken } from "./security/tokens.js";
import type { AcceptEventInput, AcceptEventResult, CatchCredentialHashes, CatchEvent, CatchResource, ProvisionInput } from "./storage/catch-repository.js";
import type { CreateWhisperInput } from "./whisper/whisper-repository.js";

const MAX_INGEST_BYTES = Math.max(...Object.values(CATCH_PLANS).map((plan) => plan.maxBytesPerRequest));
const MAX_WHISPER_BYTES = 16 * 1024;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const ALLOWED_CONTENT_TYPES = new Set(["application/json", "text/plain", "application/x-www-form-urlencoded"]);
const ALLOWED_HEADERS = new Set(["content-type", "user-agent", "x-request-id", "x-github-event", "x-github-delivery", "stripe-signature"]);
type RateLimitBucket = { count: number; resetsAt: number };

export interface CatchApiRepository {
	provision(input: ProvisionInput): Promise<CatchResource>;
	getResource(publicId: string): Promise<CatchResource | null>;
	getCredentialHashes(publicId: string): Promise<CatchCredentialHashes | null>;
	acceptEvent(input: AcceptEventInput): Promise<AcceptEventResult>;
	listEvents(publicId: string, requestedLimit: number): Promise<CatchEvent[]>;
	deleteEvent(publicId: string, eventId: string): Promise<boolean>;
	destroy(publicId: string): Promise<boolean>;
}

export interface WhisperApiRepository {
	create(input: CreateWhisperInput): Promise<{ id: string; publicId: string }>;
	getCredentialHash(publicId: string): Promise<string | null>;
	consume(publicId: string): Promise<Buffer | null>;
}

type CatchAppOptions = {
	repository: CatchApiRepository;
	tokenPepper: string;
	provisioningEnabled?: boolean;
	provisioningSecret?: string;
};

type WhisperAppOptions = {
	repository: WhisperApiRepository;
	tokenPepper: string;
	provisioningEnabled?: boolean;
	provisioningSecret?: string;
};

type PaymentAppOptions = {
	quote(input: { idempotencyKey: string; product: "catch" | "whisper"; planId: "spark" | "standard" | "long"; productPayload: Buffer | null }): Promise<PaymentQuote>;
	fulfill(orderId: string): Promise<{ settled: false } | { settled: true; resource: DispensedResource }>;
};

type BuildAppOptions = {
	logger?: boolean | object;
	trustedProxy?: string;
	catch?: CatchAppOptions;
	whisper?: WhisperAppOptions;
	payment?: PaymentAppOptions;
};

export const buildApp = (options: BuildAppOptions = {}): FastifyInstance => {
	const app = Fastify({
		logger: options.logger ?? false,
		bodyLimit: Math.max(MAX_INGEST_BYTES, MAX_WHISPER_BYTES),
		logController: new LogController({ disableRequestLogging: true }),
		trustProxy: options.trustedProxy ?? false,
	});
	if (options.whisper !== undefined || options.payment !== undefined) {
		app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
	}

	void app.register(helmet, {
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"], fontSrc: ["'self'", "https://fonts.gstatic.com"], styleSrc: ["'self'", "https://fonts.googleapis.com"], imgSrc: ["'self'", "data:"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
			},
		},
		crossOriginEmbedderPolicy: false,
	});
	void app.register(fastifyStatic, { root: join(import.meta.dirname, "..", "public"), index: "index.html", cacheControl: true, maxAge: "1h" });
	app.get("/health", () => ({ service: "the402machine", status: "ok" }));

	if (options.catch !== undefined) registerCatchRoutes(app, options.catch);
	if (options.whisper !== undefined) registerWhisperRoutes(app, options.whisper);
	if (options.payment !== undefined) registerPaymentRoutes(app, options.payment);
	return app;
};

function registerPaymentRoutes(app: FastifyInstance, payment: PaymentAppOptions): void {
	const quoteRateLimits = new Map<string, RateLimitBucket>();
	const verificationRateLimits = new Map<string, RateLimitBucket>();
	app.post<{ Body: { planId?: unknown } }>("/api/payments/catch", async (request, reply) => {
		if (!consumeRateLimit(quoteRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
		const idempotencyKey = request.headers["idempotency-key"];
		const planId = Buffer.isBuffer(request.body) ? parsePaymentPlan(request.body) : request.body?.planId;
		if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid idempotency key" });
		if (!isPlanId(planId) || !CATCH_PLANS[planId].available) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid plan" });
		const quote = await payment.quote({ idempotencyKey, product: "catch", planId, productPayload: null });
		return reply.header("Cache-Control", "no-store").code(402).send(quote);
	});

	app.post("/api/payments/whisper", async (request, reply) => {
		if (!consumeRateLimit(quoteRateLimits, request.ip, 10, 60_000)) return rateLimited(reply);
		const idempotencyKey = request.headers["idempotency-key"];
		const planId = request.headers["x-whisper-plan"];
		if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid idempotency key" });
		if (!isPlanId(planId) || !WHISPER_PLANS[planId].available) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid plan" });
		if (normalizedContentType(request.headers["content-type"]) !== "application/octet-stream" || !Buffer.isBuffer(request.body) || request.body.byteLength < 30 || request.body.byteLength > WHISPER_PLANS[planId].maxCiphertextBytes) return reply.header("Cache-Control", "no-store").code(400).send({ error: "invalid ciphertext" });
		const quote = await payment.quote({ idempotencyKey, product: "whisper", planId, productPayload: request.body });
		return reply.header("Cache-Control", "no-store").code(402).send(quote);
	});

	app.get<{ Params: { orderId: string } }>("/api/payments/:orderId", async (request, reply) => {
		if (!consumeRateLimit(verificationRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		const result = await payment.fulfill(request.params.orderId);
		if (!result.settled) return reply.header("Cache-Control", "no-store").code(402).send(result);
		const resource = result.resource.product === "catch"
			? { product: "catch", publicId: result.resource.publicId, ownerToken: result.resource.ownerToken, ingestToken: result.resource.ingestToken, expiresAt: result.resource.expiresAt.toISOString() }
			: { product: "whisper", publicId: result.resource.publicId, readToken: result.resource.readToken, expiresAt: result.resource.expiresAt.toISOString() };
		return reply.header("Cache-Control", "no-store").send({ settled: true, resource });
	});

	app.get("/api/catalog", async (_request, reply) => reply.header("Cache-Control", "public, max-age=60").send(paymentCatalogue()));
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
					catchPlan("standard", "30 days", "Temporary projects and real workflows"),
					catchPlan("long", "4 months + 2 days", "Long-running missions with a hard stop"),
				],
			},
			whisper: {
				description: "Client-encrypted message that vanishes after one successful read.",
				clientEncryption: "AES-256-GCM",
				plans: [
					whisperPlan("spark", "7 days", "Short handoff"),
					whisperPlan("standard", "42 days", "Patient delivery window"),
					whisperPlan("long", "402 days", "Long-term dead drop"),
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
	return { planId, priceSats: WHISPER_PRICES_SATS[planId], durationLabel, bestFor, readOnce: true, maxCiphertextBytes: plan.maxCiphertextBytes, available: plan.available };
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
			const expiresAt = calculateWhisperExpiry(planId, new Date());
			await options.repository.create({ publicId, planId, readTokenHash: hashToken("owner", readToken, options.tokenPepper), ciphertext: request.body, expiresAt });
			return reply.header("Cache-Control", "no-store").code(201).send({ publicId, readToken, expiresAt: expiresAt.toISOString(), maxBytes: plan.maxCiphertextBytes });
		});
	}

	app.get<{ Params: { publicId: string } }>("/w/:publicId", async (request, reply) => {
		if (!consumeRateLimit(readRateLimits, `${request.ip}:${request.params.publicId}`, 30, 60_000)) return rateLimited(reply);
		const credentialHash = await options.repository.getCredentialHash(request.params.publicId);
		if (credentialHash === null || !verifyToken("owner", bearerToken(request) ?? "", credentialHash, options.tokenPepper)) {
			return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		}
		const ciphertext = await options.repository.consume(request.params.publicId);
		if (ciphertext === null) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		return reply.header("Cache-Control", "no-store").type("application/octet-stream").send(ciphertext);
	});
}

function registerCatchRoutes(app: FastifyInstance, options: CatchAppOptions): void {
	const ingestionRateLimits = new Map<string, RateLimitBucket>();
	const provisioningRateLimits = new Map<string, RateLimitBucket>();
	const ownerRateLimits = new Map<string, RateLimitBucket>();
	for (const contentType of ALLOWED_CONTENT_TYPES) {
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

	app.post<{ Params: { publicId: string } }>("/c/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ingestionRateLimits, `${request.ip}:${request.params.publicId}`, 60, 60_000)) return rateLimited(reply);
		const contentType = normalizedContentType(request.headers["content-type"]);
		if (contentType === undefined || !ALLOWED_CONTENT_TYPES.has(contentType) || !identityEncoding(request.headers["content-encoding"])) return reply.code(400).send({ error: "invalid request" });
		const credentials = await options.repository.getCredentialHashes(request.params.publicId);
		if (credentials?.ingestTokenHash === null || credentials === null || !verifyToken("ingest", bearerToken(request) ?? "", credentials.ingestTokenHash, options.tokenPepper)) return reply.code(401).send({ error: "unauthorized" });
		if (!Buffer.isBuffer(request.body) || request.body.byteLength > MAX_INGEST_BYTES) return reply.code(400).send({ error: "invalid request" });
		const accepted = await options.repository.acceptEvent({ publicId: request.params.publicId, contentType, headers: filteredHeaders(request), body: request.body });
		if (!accepted.accepted) return reply.code(400).send({ error: "invalid request" });
		return reply.code(204).send();
	});

	app.get<{ Params: { publicId: string } }>("/api/catch/:publicId", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizeOwner(request, options)) return unauthorized(reply);
		const resource = await options.repository.getResource(request.params.publicId);
		if (resource === null) return reply.header("Cache-Control", "no-store").code(404).send({ error: "not found" });
		return reply.header("Cache-Control", "no-store").send(resourceStatus(resource));
	});

	app.get<{ Params: { publicId: string }; Querystring: { limit?: string } }>("/api/catch/:publicId/events", async (request, reply) => {
		if (!consumeRateLimit(ownerRateLimits, request.ip, 30, 60_000)) return rateLimited(reply);
		if (!await authorizeOwner(request, options)) return unauthorized(reply);
		const limit = parseLimit(request.query.limit);
		const events = await options.repository.listEvents(request.params.publicId, limit);
		return reply.header("Cache-Control", "no-store").send({ events: events.map(eventResponse) });
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
function resourceStatus(resource: CatchResource): object {
	return { publicId: resource.publicId, planId: resource.planId, status: resource.status, requestLimit: resource.requestLimit, storageLimitBytes: resource.storageLimitBytes, maxBytesPerRequest: resource.maxBytesPerRequest, acceptedRequestCount: resource.acceptedRequestCount, storedBytes: resource.storedBytes, createdAt: resource.createdAt.toISOString(), expiresAt: resource.expiresAt.toISOString() };
}
function eventResponse(event: CatchEvent): object {
	return { id: event.id, sequenceNumber: event.sequenceNumber, contentType: event.contentType, headers: event.headers, body: event.body.toString("base64"), bodyEncoding: "base64", receivedAt: event.receivedAt.toISOString() };
}

function provisionPlanId(body: unknown): unknown {
	if (Buffer.isBuffer(body)) {
		try { return (JSON.parse(body.toString("utf8")) as { planId?: unknown }).planId; } catch { return undefined; }
	}
	if (typeof body === "object" && body !== null) return (body as { planId?: unknown }).planId;
	return undefined;
}
