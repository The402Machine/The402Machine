import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type GatePaymentChallenge = {
	id: string;
	realm: string;
	method: "lightning";
	intent: "charge";
	request: string;
	expires: string;
	digest: string;
	opaque: string;
};

type GatePaymentFailure = "malformed-credential" | "invalid-challenge" | "invalid-preimage" | "expired-invoice";

export function createGatePaymentChallenge(input: {
	intentId: string;
	amountSats: number;
	bolt11: string;
	paymentHash: string;
	realm: string;
	targetMethod: string;
	targetPath: string;
	targetBody: Buffer;
	expiresAt: Date;
	secret: Buffer;
}): { parameters: GatePaymentChallenge; header: string } {
	const request = encodeCanonicalJson({ amount: String(input.amountSats), currency: "sat", description: "The402Machine GATE authorization", externalId: input.intentId, methodDetails: { invoice: input.bolt11, network: "mainnet", paymentHash: input.paymentHash } });
	const unsigned = { realm: input.realm, method: "lightning" as const, intent: "charge" as const, request, expires: input.expiresAt.toISOString(), digest: contentDigest(input.targetBody), opaque: encodeCanonicalJson({ bodySha256: createHash("sha256").update(input.targetBody).digest("hex"), intentId: input.intentId, method: input.targetMethod.toUpperCase(), path: input.targetPath }) };
	const parameters: GatePaymentChallenge = { id: challengeId(unsigned, input.secret), ...unsigned };
	const header = `Payment id="${escapeQuoted(parameters.id)}", realm="${escapeQuoted(parameters.realm)}", method="lightning", intent="charge", request="${escapeQuoted(parameters.request)}", expires="${escapeQuoted(parameters.expires)}", digest="${escapeQuoted(parameters.digest)}", opaque="${escapeQuoted(parameters.opaque)}"`;
	return { parameters, header };
}

export function parseGatePaymentAuthorization(value: string | undefined): { challenge: GatePaymentChallenge; preimage: string } | null {
	if (value === undefined || !value.startsWith("Payment ")) return null;
	const token = value.slice("Payment ".length);
	if (!/^[A-Za-z0-9_-]+$/u.test(token)) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (!isRecord(parsed) || !isChallenge(parsed.challenge) || !isRecord(parsed.payload) || !isPreimage(parsed.payload.preimage)) return null;
		return { challenge: parsed.challenge, preimage: parsed.payload.preimage };
	} catch { return null; }
}

export function verifyGatePaymentCredential(input: { authorization: string | undefined; intentId: string; targetMethod: string; targetPath: string; targetBody: Buffer; secret: Buffer; now: Date }): { valid: true; preimage: string; paymentHash: string } | { valid: false; reason: GatePaymentFailure } {
	const parsed = parseGatePaymentAuthorization(input.authorization);
	if (parsed === null) return { valid: false, reason: "malformed-credential" };
	if (input.now.getTime() >= Date.parse(parsed.challenge.expires)) return { valid: false, reason: "expired-invoice" };
	if (parsed.challenge.id !== challengeId(parsed.challenge, input.secret) || parsed.challenge.digest !== contentDigest(input.targetBody)) return { valid: false, reason: "invalid-challenge" };
	const opaque = decodeOpaque(parsed.challenge.opaque);
	if (opaque === null || opaque.intentId !== input.intentId || opaque.method !== input.targetMethod.toUpperCase() || opaque.path !== input.targetPath || opaque.bodySha256 !== createHash("sha256").update(input.targetBody).digest("hex")) return { valid: false, reason: "invalid-challenge" };
	const paymentHash = decodePaymentHash(parsed.challenge.request);
	if (paymentHash === null) return { valid: false, reason: "invalid-challenge" };
	const preimageHash = createHash("sha256").update(Buffer.from(parsed.preimage, "hex")).digest("hex");
	if (!safeEqual(preimageHash, paymentHash)) return { valid: false, reason: "invalid-preimage" };
	return { valid: true, preimage: parsed.preimage, paymentHash };
}

function challengeId(parameters: Omit<GatePaymentChallenge, "id"> | GatePaymentChallenge, secret: Buffer): string {
	const joined = [parameters.realm, parameters.method, parameters.intent, parameters.request, parameters.expires, parameters.digest, parameters.opaque].join("|");
	return createHmac("sha256", secret).update(joined, "utf8").digest("base64url");
}
function contentDigest(body: Buffer): string { return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`; }
function encodeCanonicalJson(value: Record<string, unknown>): string { return Buffer.from(canonicalJson(value), "utf8").toString("base64url"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; throw new Error("Value cannot be serialized"); }
function decodeOpaque(value: string): { intentId: string; method: string; path: string; bodySha256: string } | null { try { const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); return isRecord(parsed) && typeof parsed.intentId === "string" && typeof parsed.method === "string" && typeof parsed.path === "string" && typeof parsed.bodySha256 === "string" ? parsed as { intentId: string; method: string; path: string; bodySha256: string } : null; } catch { return null; } }
function decodePaymentHash(value: string): string | null { try { const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); return isRecord(parsed) && isRecord(parsed.methodDetails) && typeof parsed.methodDetails.paymentHash === "string" && /^[a-f0-9]{64}$/u.test(parsed.methodDetails.paymentHash) ? parsed.methodDetails.paymentHash : null; } catch { return null; } }
function isChallenge(value: unknown): value is GatePaymentChallenge { return isRecord(value) && typeof value.id === "string" && typeof value.realm === "string" && value.method === "lightning" && value.intent === "charge" && typeof value.request === "string" && typeof value.expires === "string" && typeof value.digest === "string" && typeof value.opaque === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPreimage(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
function escapeQuoted(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
