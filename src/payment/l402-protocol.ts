import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { bytesToBase64, importMacaroon, newMacaroon } from "@unional/macaroon";

import type { PaymentProduct, PurchasableCatchPlanId } from "./payment-domain.js";

type L402Failure = "malformed-credential" | "invalid-macaroon" | "invalid-preimage" | "invalid-caveat" | "expired";

type L402CaveatContext = {
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	method: string;
	path: string;
	body: Buffer;
	now: Date;
};

export function createL402Challenge(input: {
	paymentHash: string;
	bolt11: string;
	rootKey: Buffer;
	tokenId?: Buffer;
	location: string;
	product: PaymentProduct;
	planId: PurchasableCatchPlanId;
	method: string;
	path: string;
	body: Buffer;
	expiresAt: Date;
}): { macaroon: string; header: string } {
	if (!isPaymentHash(input.paymentHash)) throw new Error("L402 payment hash must contain 32 bytes");
	if (input.rootKey.byteLength !== 32) throw new Error("L402 root key must contain 32 bytes");
	const tokenId = input.tokenId ?? randomBytes(32);
	if (tokenId.byteLength !== 32) throw new Error("L402 token id must contain 32 bytes");
	const identifier = Buffer.alloc(66);
	identifier.writeUInt16BE(0, 0);
	Buffer.from(input.paymentHash, "hex").copy(identifier, 2);
	tokenId.copy(identifier, 34);
	const macaroon = newMacaroon({ identifier, location: input.location, rootKey: input.rootKey, version: 2 });
	for (const caveat of expectedCaveats(input, input.expiresAt)) macaroon.addFirstPartyCaveat(caveat);
	const binary = macaroon.exportBinary();
	if (binary === undefined) throw new Error("L402 requires a version 2 binary macaroon");
	const serialized = bytesToBase64(binary);
	return { macaroon: serialized, header: `L402 macaroon="${serialized}", invoice="${escapeQuoted(input.bolt11)}"` };
}

export function verifyL402Authorization(input: L402CaveatContext & {
	authorization: string | undefined;
	rootKey: Buffer;
	expectedPaymentHash: string;
}): { valid: true; preimage: string; paymentHash: string } | { valid: false; reason: L402Failure } {
	const credential = parseL402Authorization(input.authorization);
	if (credential === null) return { valid: false, reason: "malformed-credential" };
	let macaroon: ReturnType<typeof newMacaroon>;
	try {
		macaroon = importMacaroon(credential.macaroon);
	} catch {
		return { valid: false, reason: "invalid-macaroon" };
	}
	const identifier = Buffer.from(macaroon.identifier);
	if (identifier.byteLength !== 66 || identifier.readUInt16BE(0) !== 0) return { valid: false, reason: "invalid-macaroon" };
	const paymentHash = identifier.subarray(2, 34).toString("hex");
	if (!safeEqual(paymentHash, input.expectedPaymentHash)) return { valid: false, reason: "invalid-macaroon" };
	let caveats: string[];
	try {
		caveats = macaroon.caveats.map(({ identifier: caveat }) => Buffer.from(caveat).toString("utf8"));
		macaroon.verify(input.rootKey, (condition) => caveatSatisfied(condition, input), []);
	} catch {
		return { valid: false, reason: "invalid-macaroon" };
	}
	const expiry = caveats.find((caveat) => caveat.startsWith("valid_until="))?.slice("valid_until=".length);
	if (expiry === undefined || !/^\d+$/u.test(expiry)) return { valid: false, reason: "invalid-caveat" };
	if (input.now.getTime() >= Number(expiry) * 1_000) return { valid: false, reason: "expired" };
	const required = expectedCaveats(input, new Date(Number(expiry) * 1_000));
	if (!required.every((caveat) => caveats.includes(caveat))) return { valid: false, reason: "invalid-caveat" };
	const hashed = createHash("sha256").update(Buffer.from(credential.preimage, "hex")).digest("hex");
	if (!safeEqual(hashed, paymentHash)) return { valid: false, reason: "invalid-preimage" };
	return { valid: true, preimage: credential.preimage, paymentHash };
}

export function parseL402Authorization(value: string | undefined): { macaroon: string; preimage: string } | null {
	if (value === undefined || !value.startsWith("L402 ")) return null;
	const credential = value.slice("L402 ".length);
	const separator = credential.lastIndexOf(":");
	if (separator < 1) return null;
	const macaroon = credential.slice(0, separator);
	const preimage = credential.slice(separator + 1);
	return /^[A-Za-z0-9_-]+$/u.test(macaroon) && /^[a-f0-9]{64}$/u.test(preimage) ? { macaroon, preimage } : null;
}

function expectedCaveats(input: Omit<L402CaveatContext, "now">, expiresAt: Date): string[] {
	return [
		"services=the402machine:0",
		"the402machine_capabilities=provision",
		`product=${input.product}`,
		`plan=${input.planId}`,
		`method=${input.method.toUpperCase()}`,
		`path=${input.path}`,
		`body_sha256=${createHash("sha256").update(input.body).digest("hex")}`,
		`valid_until=${Math.floor(expiresAt.getTime() / 1_000)}`,
	];
}

function caveatSatisfied(condition: string, input: L402CaveatContext): string | null {
	if (condition === "services=the402machine:0" || condition === "the402machine_capabilities=provision") return null;
	if (condition === `product=${input.product}` || condition === `plan=${input.planId}` || condition === `method=${input.method.toUpperCase()}` || condition === `path=${input.path}`) return null;
	if (condition === `body_sha256=${createHash("sha256").update(input.body).digest("hex")}`) return null;
	if (/^valid_until=\d+$/u.test(condition)) return null;
	return "unsatisfied L402 caveat";
}

function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
function isPaymentHash(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function escapeQuoted(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
