import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type PulseTokenRole = "owner" | "ping";
const PREFIXES: Readonly<Record<PulseTokenRole, string>> = { owner: "pulse_own_", ping: "pulse_ping_" };
const PAYLOAD = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;

export function generatePulseToken(role: PulseTokenRole): string {
	return `${PREFIXES[role]}${randomBytes(32).toString("base64url")}`;
}

export function hashPulseToken(role: PulseTokenRole, token: string, pepper: string): string {
	if (pepper.length === 0) throw new Error("A non-empty token pepper is required");
	return createHmac("sha256", pepper).update(`pulse:${role}\0${token}`, "utf8").digest("hex");
}

export function verifyPulseToken(role: PulseTokenRole, token: string, expectedHash: string, pepper: string): boolean {
	if (!token.startsWith(PREFIXES[role]) || !PAYLOAD.test(token.slice(PREFIXES[role].length)) || !HASH.test(expectedHash)) return false;
	const actual = Buffer.from(hashPulseToken(role, token, pepper), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return timingSafeEqual(actual, expected);
}
