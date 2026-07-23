import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type CatchTokenRole = "ingest" | "owner";

const TOKEN_PREFIX: Readonly<Record<CatchTokenRole, string>> = {
	ingest: "catch_ing_",
	owner: "catch_own_",
};

const TOKEN_ENTROPY_BYTES = 32;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateIngestToken(): string {
	return generateToken("ingest");
}

export function generateOwnerToken(): string {
	return generateToken("owner");
}

export function hashToken(role: CatchTokenRole, token: string, pepper: string): string {
	requirePepper(pepper);
	return createHmac("sha256", pepper).update(`${role}\0${token}`, "utf8").digest("hex");
}

export function verifyToken(
	role: CatchTokenRole,
	token: string,
	expectedHash: string,
	pepper: string,
): boolean {
	requirePepper(pepper);

	const prefix = TOKEN_PREFIX[role];
	if (!token.startsWith(prefix) || !TOKEN_PAYLOAD_PATTERN.test(token.slice(prefix.length))) {
		return false;
	}

	if (!SHA256_HEX_PATTERN.test(expectedHash)) {
		return false;
	}

	const actualHash = hashToken(role, token, pepper);
	const actual = Buffer.from(actualHash, "hex");
	const expected = Buffer.from(expectedHash, "hex");

	return timingSafeEqual(actual, expected);
}

function generateToken(role: CatchTokenRole): string {
	return `${TOKEN_PREFIX[role]}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
}

function requirePepper(pepper: string): void {
	if (pepper.length === 0) {
		throw new Error("A non-empty token pepper is required");
	}
}
