import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { decode } from "bolt11-ts";
import { Agent } from "undici";

import { validateBolt11, type ValidatedBolt11 } from "../payment/bolt11-validation.js";
import { normalizeLightningAddress } from "./gate-domain.js";

const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 5_000;

type ResolveHostname = (hostname: string) => Promise<string[]>;

type LnurlPayRequest = {
	callback: string;
	minSendable: number;
	maxSendable: number;
	metadata: string;
	tag: "payRequest";
};

export type GateInvoiceVerification = { type: "url"; url: string } | { type: "payer-preimage" };

export type GateLightningInvoice = ValidatedBolt11 & {
	bolt11: string;
	verification: GateInvoiceVerification;
};

type LightningAddressAdapterOptions = {
	fetchImplementation?: typeof fetch;
	resolveHostname?: ResolveHostname;
	timeoutMs?: number;
};

export class LightningAddressAdapter {
	readonly #fetch: typeof fetch;
	readonly #resolveHostname: ResolveHostname;
	readonly #timeoutMs: number;
	readonly #pinDns: boolean;

	constructor(options: LightningAddressAdapterOptions = {}) {
		this.#fetch = options.fetchImplementation ?? fetch;
		this.#resolveHostname = options.resolveHostname ?? resolveWithDns;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#pinDns = options.fetchImplementation === undefined;
	}

	async createInvoice(input: { lightningAddress: string; amountSats: number }): Promise<GateLightningInvoice> {
		if (!Number.isSafeInteger(input.amountSats) || input.amountSats < 1) throw new Error("Lightning amount is invalid");
		const address = normalizeLightningAddress(input.lightningAddress);
		const separator = address.lastIndexOf("@");
		const user = address.slice(0, separator);
		const domain = address.slice(separator + 1);
		const discoveryUrl = new URL(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`);
		const payRequest = parsePayRequest(await this.#fetchJson(discoveryUrl));
		const amountMillisats = input.amountSats * 1_000;
		if (amountMillisats < payRequest.minSendable || amountMillisats > payRequest.maxSendable) throw new Error("Lightning amount is outside recipient range");

		const callbackUrl = await this.#validatedPublicUrl(payRequest.callback);
		callbackUrl.searchParams.set("amount", String(amountMillisats));
		const invoiceResponse = parseInvoiceResponse(await this.#fetchJson(callbackUrl));
		const decodedInvoice = await decodeInvoice(invoiceResponse.pr);
		const validated = await validateBolt11({ bolt11: invoiceResponse.pr, expectedPaymentHash: decodedInvoice.paymentHash, expectedAmountSats: input.amountSats, expectedDescriptionHash: payRequest.metadata });
		if (validated.network !== "mainnet") throw new Error("Lightning invoice must use mainnet");

		const verification = invoiceResponse.verify === undefined
			? { type: "payer-preimage" } as const
			: { type: "url", url: (await this.#validatedPublicUrl(invoiceResponse.verify)).toString() } as const;
		return { ...validated, bolt11: invoiceResponse.pr, verification };
	}

	async verifyInvoice(input: { bolt11: string; paymentHash: string; amountSats: number; verification: GateInvoiceVerification }): Promise<{ settled: false } | { settled: true; preimage?: string }> {
		if (input.verification.type === "payer-preimage") return { settled: false };
		const verifyUrl = await this.#validatedPublicUrl(input.verification.url);
		const response = parseVerificationResponse(await this.#fetchJson(verifyUrl));
		if (response.pr !== input.bolt11) throw new Error("Lightning verification invoice mismatch");
		await validateBolt11({ bolt11: response.pr, expectedPaymentHash: input.paymentHash, expectedAmountSats: input.amountSats });
		if (!response.settled) return { settled: false };
		if (response.preimage === undefined) throw new Error("Lightning verification did not provide a cryptographic proof");
		const preimageHash = createHash("sha256").update(Buffer.from(response.preimage, "hex")).digest("hex");
		if (preimageHash !== input.paymentHash) throw new Error("Lightning verification preimage mismatch");
		return { settled: true, preimage: response.preimage };
	}

	async #fetchJson(url: URL): Promise<unknown> {
		const [pinnedAddress] = await this.#publicAddresses(url);
		if (pinnedAddress === undefined) throw new Error("Lightning provider requires a public HTTPS endpoint");
		const dispatcher = this.#pinDns ? new Agent({ connect: { lookup: createPinnedLookup(pinnedAddress) } }) : null;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
		let response: Response;
		try {
			const request = { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: controller.signal } as RequestInit & { dispatcher?: Agent };
			if (dispatcher !== null) request.dispatcher = dispatcher;
			response = await this.#fetch(url, request);
		} finally {
			clearTimeout(timeout);
			await dispatcher?.close();
		}
		if (response.status >= 300 && response.status < 400) throw new Error("Lightning provider redirect is not allowed");
		if (!response.ok) throw new Error(`Lightning provider returned HTTP ${response.status}`);
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Lightning provider response is too large");
		const body = await response.text();
		if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Lightning provider response is too large");
		try { return JSON.parse(body) as unknown; }
		catch { throw new Error("Lightning provider returned invalid JSON"); }
	}

	async #validatedPublicUrl(value: string): Promise<URL> {
		let url: URL;
		try { url = new URL(value); }
		catch { throw new Error("Lightning provider URL is invalid"); }
		await this.#publicAddresses(url);
		return url;
	}

	async #publicAddresses(url: URL): Promise<string[]> {
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") throw new Error("Lightning provider requires a public HTTPS endpoint");
		const hostname = url.hostname.toLowerCase();
		if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Lightning provider requires a public HTTPS endpoint");
		const literal = ipLiteral(hostname);
		const addresses = literal === null ? await this.#resolveHostname(hostname) : [literal];
		if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) throw new Error("Lightning provider requires a public HTTPS endpoint");
		return addresses;
	}
}

function parsePayRequest(value: unknown): LnurlPayRequest {
	if (!isRecord(value) || value.tag !== "payRequest" || typeof value.callback !== "string" || typeof value.metadata !== "string" || !positiveInteger(value.minSendable) || !positiveInteger(value.maxSendable) || value.minSendable > value.maxSendable) throw new Error("Lightning Address returned an invalid LNURL-pay request");
	try { const metadata: unknown = JSON.parse(value.metadata); if (!Array.isArray(metadata)) throw new Error(); }
	catch { throw new Error("Lightning Address metadata is invalid"); }
	return { callback: value.callback, minSendable: value.minSendable, maxSendable: value.maxSendable, metadata: value.metadata, tag: "payRequest" };
}

function parseInvoiceResponse(value: unknown): { pr: string; verify?: string } {
	if (!isRecord(value) || typeof value.pr !== "string") throw new Error("Lightning Address returned an invalid invoice response");
	if (value.verify === undefined) return { pr: value.pr };
	if (typeof value.verify !== "string") throw new Error("Lightning Address returned an invalid verification URL");
	return { pr: value.pr, verify: value.verify };
}

function parseVerificationResponse(value: unknown): { settled: boolean; pr: string; preimage?: string } {
	if (!isRecord(value) || typeof value.settled !== "boolean" || typeof value.pr !== "string") throw new Error("Lightning provider returned invalid verification data");
	if (value.preimage === null || value.preimage === undefined) return { settled: value.settled, pr: value.pr };
	if (typeof value.preimage !== "string" || !/^[a-fA-F0-9]{64}$/u.test(value.preimage)) throw new Error("Lightning provider returned an invalid preimage");
	return { settled: value.settled, pr: value.pr, preimage: value.preimage.toLowerCase() };
}

async function decodeInvoice(bolt11: string): Promise<{ paymentHash: string }> {
	try { const invoice = await decode(bolt11); if (typeof invoice.tagsObject.payment_hash !== "string") throw new Error(); return { paymentHash: invoice.tagsObject.payment_hash }; }
	catch { throw new Error("Lightning invoice is not valid BOLT11"); }
}

async function resolveWithDns(hostname: string): Promise<string[]> {
	const { resolve4, resolve6 } = await import("node:dns/promises");
	const [ipv4, ipv6] = await Promise.all([resolve4(hostname).catch(() => []), resolve6(hostname).catch(() => [])]);
	return [...ipv4, ...ipv6];
}

export function createPinnedLookup(pinnedAddress: string) {
	const family = isIP(pinnedAddress);
	if (family === 0) throw new Error("Pinned Lightning provider address is invalid");
	return (_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void): void => callback(null, pinnedAddress, family);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function ipLiteral(hostname: string): string | null { if (isIP(hostname) !== 0) return hostname; return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : null; }
function isPublicIp(address: string): boolean { if (isIP(address) === 4) return isPublicIpv4(address); if (isIP(address) === 6) return isPublicIpv6(address); return false; }
function isPublicIpv4(address: string): boolean {
	const octets = address.split(".").map(Number); const first = octets[0] ?? -1; const second = octets[1] ?? -1;
	if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
	if (first === 169 && second === 254) return false;
	if (first === 172 && second >= 16 && second <= 31) return false;
	if (first === 192 && (second === 0 || second === 168)) return false;
	if (first === 198 && (second === 18 || second === 19)) return false;
	if (first === 100 && second >= 64 && second <= 127) return false;
	return true;
}
function isPublicIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		const tail = normalized.slice("::ffff:".length);
		if (isIP(tail) === 4) return isPublicIpv4(tail);
		const parts = tail.split(":"); const first = Number.parseInt(parts[0] ?? "", 16); const second = Number.parseInt(parts[1] ?? "", 16);
		return parts.length === 2 && Number.isInteger(first) && Number.isInteger(second) && isPublicIpv4(`${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`);
	}
	if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
	if (normalized.startsWith("2001:db8:")) return false;
	return true;
}
