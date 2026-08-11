import { createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";

export type GateReceiptBinding = {
	projectId: string;
	routeId: string;
	method: string;
	path: string;
	bodyDigest: string;
	amountSats: number;
	paymentHash: string;
	jti: string;
};

export type GateReceiptClaims = {
	iss: string;
	aud: string;
	route: string;
	method: string;
	path: string;
	body_sha256: string;
	amount_sats: number;
	payment_hash: string;
	jti: string;
	iat: number;
	exp: number;
};

type GateReceiptHeader = { alg: "EdDSA"; kid: string; typ: "gate+jwt" };

export function createGateReceipt(input: GateReceiptBinding & { issuer: string; privateKey: KeyObject; keyId: string; now: Date; expiresAt: Date }): string {
	if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") throw new Error("GATE receipt key must be an Ed25519 private key");
	if (input.expiresAt.getTime() <= input.now.getTime()) throw new Error("GATE receipt expiry must be after issuance");
	const header: GateReceiptHeader = { alg: "EdDSA", kid: input.keyId, typ: "gate+jwt" };
	const claims: GateReceiptClaims = {
		iss: input.issuer,
		aud: input.projectId,
		route: input.routeId,
		method: input.method.toUpperCase(),
		path: input.path,
		body_sha256: input.bodyDigest,
		amount_sats: input.amountSats,
		payment_hash: input.paymentHash,
		jti: input.jti,
		iat: Math.floor(input.now.getTime() / 1_000),
		exp: Math.floor(input.expiresAt.getTime() / 1_000),
	};
	const encodedHeader = encodeJson(header);
	const encodedClaims = encodeJson(claims);
	const signingInput = `${encodedHeader}.${encodedClaims}`;
	const signature = sign(null, Buffer.from(signingInput, "ascii"), input.privateKey).toString("base64url");
	return `${signingInput}.${signature}`;
}

export function verifyGateReceipt(input: { receipt: string; publicKey: KeyObject; issuer: string; keyId?: string; expected: GateReceiptBinding; now: Date }): { valid: true; claims: GateReceiptClaims } | { valid: false } {
	if (input.publicKey.type !== "public" || input.publicKey.asymmetricKeyType !== "ed25519") return { valid: false };
	const segments = input.receipt.split(".");
	if (segments.length !== 3) return { valid: false };
	const [encodedHeader, encodedClaims, encodedSignature] = segments;
	if (encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined || !base64url(encodedHeader) || !base64url(encodedClaims) || !base64url(encodedSignature)) return { valid: false };
	let header: unknown;
	let claims: unknown;
	try {
		header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown;
		claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as unknown;
	} catch {
		return { valid: false };
	}
	if (!isHeader(header) || !isClaims(claims) || (input.keyId !== undefined && !safeEqual(header.kid, input.keyId))) return { valid: false };
	if (!verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"), input.publicKey, Buffer.from(encodedSignature, "base64url"))) return { valid: false };
	if (claims.exp <= Math.floor(input.now.getTime() / 1_000) || claims.iat > Math.floor(input.now.getTime() / 1_000) + 30 || claims.exp <= claims.iat || claims.exp - claims.iat > 5 * 60) return { valid: false };
	const expected = input.expected;
	const matches = [
		[claims.iss, input.issuer], [claims.aud, expected.projectId], [claims.route, expected.routeId], [claims.method, expected.method.toUpperCase()], [claims.path, expected.path],
		[claims.body_sha256, expected.bodyDigest], [claims.payment_hash, expected.paymentHash], [claims.jti, expected.jti],
	].every(([left, right]) => typeof left === "string" && typeof right === "string" && safeEqual(left, right));
	if (!matches || claims.amount_sats !== expected.amountSats) return { valid: false };
	return { valid: true, claims };
}

export function gateReceiptJwks(input: { publicKey: KeyObject; keyId: string }): { keys: Array<{ kty: "OKP"; crv: "Ed25519"; x: string; kid: string; use: "sig"; alg: "EdDSA" }> } {
	const publicKey = input.publicKey.type === "public" ? input.publicKey : createPublicKey(input.publicKey);
	if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("GATE receipt key must be Ed25519");
	const jwk = publicKey.export({ format: "jwk" });
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("GATE receipt public key is invalid");
	return { keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: input.keyId, use: "sig", alg: "EdDSA" }] };
}

function encodeJson(value: object): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function base64url(value: string): boolean { return /^[A-Za-z0-9_-]+$/u.test(value); }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isHeader(value: unknown): value is GateReceiptHeader { return isRecord(value) && value.alg === "EdDSA" && value.typ === "gate+jwt" && typeof value.kid === "string"; }
function isClaims(value: unknown): value is GateReceiptClaims {
	return isRecord(value) && typeof value.iss === "string" && typeof value.aud === "string" && typeof value.route === "string" && typeof value.method === "string" && typeof value.path === "string" && typeof value.body_sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.body_sha256) && typeof value.amount_sats === "number" && Number.isSafeInteger(value.amount_sats) && typeof value.payment_hash === "string" && /^[a-f0-9]{64}$/u.test(value.payment_hash) && typeof value.jti === "string" && typeof value.iat === "number" && Number.isSafeInteger(value.iat) && typeof value.exp === "number" && Number.isSafeInteger(value.exp);
}
