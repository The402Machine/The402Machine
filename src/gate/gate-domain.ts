import { createHash } from "node:crypto";

export type GatePackId = "spark" | "standard" | "long";
export type GateMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface GatePack {
	readonly id: GatePackId;
	readonly authorizations: number;
	readonly priceSats: number;
	/** GATE credits are service entitlements, never transferable funds. */
	readonly transferable: false;
}

export interface GateRouteInput {
	readonly key: string;
	readonly method: string;
	readonly path: string;
	readonly priceSats: number;
}

export interface GateRoute {
	readonly key: string;
	readonly method: GateMethod;
	readonly path: string;
	readonly priceSats: number;
}

export interface GateRequestBindingInput {
	readonly method: string;
	readonly path: string;
	readonly body: Uint8Array;
}

export interface GateRequestBinding {
	readonly method: GateMethod;
	readonly path: string;
	readonly bodyDigest: string;
}

export const GATE_FREE_AUTHORIZATIONS_PER_MONTH = 25;
export const GATE_GRANT_EXPIRY_DAYS = 402;
export const GATE_MIN_ROUTE_PRICE_SATS = 1;
export const GATE_MAX_ROUTE_PRICE_SATS = 1_000_000;

export const GATE_PACKS: Readonly<Record<GatePackId, GatePack>> = Object.freeze({
	spark: Object.freeze({ id: "spark", authorizations: 420, priceSats: 42, transferable: false }),
	standard: Object.freeze({ id: "standard", authorizations: 4_200, priceSats: 402, transferable: false }),
	long: Object.freeze({ id: "long", authorizations: 42_000, priceSats: 4_002, transferable: false }),
});

const GATE_METHODS = new Set<GateMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const ROUTE_KEY = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;
const LIGHTNING_LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function calculateGateGrantExpiry(purchasedAt: Date): Date {
	assertValidDate(purchasedAt, "A valid purchase date is required");
	return new Date(purchasedAt.getTime() + GATE_GRANT_EXPIRY_DAYS * 24 * 60 * 60 * 1_000);
}

export function gateMonthKey(date: Date): string {
	assertValidDate(date, "A valid date is required");
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function normalizeLightningAddress(value: string): string {
	const address = value.trim();
	const at = address.lastIndexOf("@");
	if (at <= 0 || at !== address.indexOf("@") || at === address.length - 1) {
		throw new Error("Lightning Address must be a valid LUD-16 address");
	}

	const localPart = address.slice(0, at);
	const host = address.slice(at + 1).toLowerCase();
	if (!LIGHTNING_LOCAL_PART.test(localPart) || !HOSTNAME.test(host)) {
		throw new Error("Lightning Address must be a valid LUD-16 address");
	}

	return `${localPart}@${host}`;
}

export function lightningAddressWellKnownUrl(lightningAddress: string): string {
	const normalized = normalizeLightningAddress(lightningAddress);
	const at = normalized.lastIndexOf("@");
	const localPart = normalized.slice(0, at);
	const host = normalized.slice(at + 1);
	return `https://${host}/.well-known/lnurlp/${encodeURIComponent(localPart)}`;
}

export function validateGateRoute(input: GateRouteInput): GateRoute {
	if (!ROUTE_KEY.test(input.key)) throw new Error("GATE route key is invalid");
	const method = normalizeGateMethod(input.method);
	const path = validateGatePath(input.path);
	if (!Number.isSafeInteger(input.priceSats) || input.priceSats < GATE_MIN_ROUTE_PRICE_SATS || input.priceSats > GATE_MAX_ROUTE_PRICE_SATS) {
		throw new Error(`GATE route price must be an integer between ${GATE_MIN_ROUTE_PRICE_SATS} and ${GATE_MAX_ROUTE_PRICE_SATS} sats`);
	}
	return { key: input.key, method, path, priceSats: input.priceSats };
}

export function validateGateRequestBinding(input: GateRequestBindingInput): GateRequestBinding {
	const method = normalizeGateMethod(input.method);
	const path = validateGatePath(input.path);
	return { method, path, bodyDigest: createHash("sha256").update(input.body).digest("hex") };
}

function normalizeGateMethod(value: string): GateMethod {
	const method = value.toUpperCase();
	if (!GATE_METHODS.has(method as GateMethod)) throw new Error("GATE method is not allowed");
	return method as GateMethod;
}

function validateGatePath(value: string): string {
	if (value.length === 0 || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#") || containsControlCharacter(value)) {
		throw new Error("GATE path must be a bounded absolute query-free path");
	}
	return value;
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function assertValidDate(value: Date, message: string): void {
	if (Number.isNaN(value.getTime())) throw new Error(message);
}
