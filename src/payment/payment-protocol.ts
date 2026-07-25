import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { PaymentQuote } from "./payment-service.js";

export type PaymentChallengeParameters = {
	id: string;
	realm: string;
	method: "lightning";
	intent: "charge";
	request: string;
	digest: string;
	expires: string;
	opaque: string;
};

type PaymentCredentialFailure = "malformed-credential" | "invalid-challenge" | "invalid-preimage" | "expired-invoice";

export function createPaymentChallenge(input: {
	quote: PaymentQuote;
	realm: string;
	method: string;
	path: string;
	body: Buffer;
	expiresAt: Date;
	secret: Buffer;
}): { parameters: PaymentChallengeParameters; header: string } {
	const request = encodeCanonicalJson({
		amount: String(input.quote.amountSats),
		currency: "sat",
		description: `The402Machine ${input.quote.product.toUpperCase()} ${titleCase(input.quote.planId)}`,
		externalId: input.quote.orderId,
		methodDetails: { invoice: input.quote.bolt11, network: input.quote.network ?? "mainnet", paymentHash: input.quote.paymentHash },
	});
	const digest = contentDigest(input.body);
	const expires = input.expiresAt.toISOString();
	const opaque = encodeCanonicalJson({ method: input.method.toUpperCase(), orderId: input.quote.orderId, path: input.path });
	const parametersWithoutId = { realm: input.realm, method: "lightning" as const, intent: "charge" as const, request, digest, expires, opaque };
	const id = challengeId(parametersWithoutId, input.secret);
	const parameters: PaymentChallengeParameters = { id, ...parametersWithoutId };
	return {
		parameters,
		header: `Payment id="${id}", realm="${escapeQuoted(input.realm)}", method="lightning", intent="charge", request="${request}", digest="${digest}", expires="${expires}", opaque="${opaque}"`,
	};
}

export function parsePaymentAuthorization(value: string | undefined): { challenge: PaymentChallengeParameters; preimage: string } | null {
	if (value === undefined || !value.startsWith("Payment ")) return null;
	const token = value.slice("Payment ".length);
	if (!/^[A-Za-z0-9_-]+$/u.test(token)) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (!isRecord(parsed) || !isPaymentChallengeParameters(parsed.challenge) || !isRecord(parsed.payload) || !isPreimage(parsed.payload.preimage)) return null;
		return { challenge: parsed.challenge, preimage: parsed.payload.preimage };
	} catch {
		return null;
	}
}

export function verifyPaymentCredential(input: {
	authorization: string | undefined;
	expected: PaymentChallengeParameters;
	body: Buffer;
	secret: Buffer;
	now: Date;
}): { valid: true; paymentHash: string } | { valid: false; reason: PaymentCredentialFailure } {
	const parsed = parsePaymentAuthorization(input.authorization);
	if (parsed === null) return { valid: false, reason: "malformed-credential" };
	if (input.now.getTime() >= Date.parse(input.expected.expires)) return { valid: false, reason: "expired-invoice" };
	if (!safeParametersEqual(parsed.challenge, input.expected)) return { valid: false, reason: "invalid-challenge" };
	if (input.expected.id !== challengeId(input.expected, input.secret) || input.expected.digest !== contentDigest(input.body)) return { valid: false, reason: "invalid-challenge" };
	const paymentRequest = decodeRequest(input.expected.request);
	if (paymentRequest === null) return { valid: false, reason: "invalid-challenge" };
	const paymentHash = createHash("sha256").update(Buffer.from(parsed.preimage, "hex")).digest("hex");
	if (!safeStringEqual(paymentHash, paymentRequest.methodDetails.paymentHash)) return { valid: false, reason: "invalid-preimage" };
	return { valid: true, paymentHash };
}

export function createPaymentReceipt(input: { challengeId: string; paymentHash: string; settledAt: Date }): string {
	return encodeCanonicalJson({ challengeId: input.challengeId, method: "lightning", reference: input.paymentHash, status: "success", timestamp: input.settledAt.toISOString() });
}

export function paymentChallengeFingerprint(parameters: PaymentChallengeParameters): string {
	return createHash("sha256").update(canonicalJson(parameters), "utf8").digest("hex");
}

function challengeId(parameters: Omit<PaymentChallengeParameters, "id">, secret: Buffer): string {
	const joined = [parameters.realm, parameters.method, parameters.intent, parameters.request, parameters.expires, parameters.digest, parameters.opaque].join("|");
	return createHmac("sha256", secret).update(joined, "utf8").digest("base64url");
}

function contentDigest(body: Buffer): string { return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`; }

function encodeCanonicalJson(value: Record<string, unknown>): string { return Buffer.from(canonicalJson(value), "utf8").toString("base64url"); }

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	throw new Error("Value cannot be serialized with JCS");
}

function decodeRequest(value: string): { methodDetails: { paymentHash: string } } | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.methodDetails) || !isPaymentHash(parsed.methodDetails.paymentHash)) return null;
		return { methodDetails: { paymentHash: parsed.methodDetails.paymentHash } };
	} catch { return null; }
}

function isPaymentChallengeParameters(value: unknown): value is PaymentChallengeParameters {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.realm === "string" && value.method === "lightning" && value.intent === "charge" && typeof value.request === "string" && typeof value.digest === "string" && typeof value.expires === "string" && typeof value.opaque === "string";
}

function safeParametersEqual(left: PaymentChallengeParameters, right: PaymentChallengeParameters): boolean { return safeStringEqual(canonicalJson(left), canonicalJson(right)); }
function safeStringEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPreimage(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isPaymentHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function escapeQuoted(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
