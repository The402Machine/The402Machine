import { createHash, type KeyObject } from "node:crypto";

import { verifyGateReceipt } from "./gate-receipt.js";

export type GateClientOptions = {
	gateBaseUrl: string;
	projectId: string;
	projectKey: string;
	routeKey: string;
	routeId?: string;
	receiptPublicKey: KeyObject;
	receiptKeyId: string;
	fetchImplementation?: typeof fetch;
};

export type GateAuthorizeRequest = { method: string; path: string; body?: Buffer; headers?: HeadersInit; idempotencyKey: string };
export type GateAuthorizeResult = { authorized: true; receipt: string; response: Response } | { authorized: false; status: number; headers: Headers; body: Buffer };

export function createGateClient(options: GateClientOptions): { authorize(request: GateAuthorizeRequest): Promise<GateAuthorizeResult> } {
	const baseUrl = validatedBaseUrl(options.gateBaseUrl);
	const fetchImplementation = options.fetchImplementation ?? fetch;
	if (!/^gate_project_[A-Za-z0-9_-]+$/u.test(options.projectId)) throw new Error("GATE project id is invalid");
	if (options.projectKey.length < 16 || options.projectKey.length > 256) throw new Error("GATE project key is invalid");
	return {
		async authorize(request) {
			const method = request.method.toUpperCase();
			const body = request.body ?? Buffer.alloc(0);
			const headers = sanitizeHeaders(request.headers);
			headers.set("Authorization", `Bearer ${options.projectKey}`);
			headers.set("Idempotency-Key", request.idempotencyKey);
			headers.set("X-Gate-Project", options.projectId);
			headers.set("X-Gate-Route", options.routeKey);
			headers.set("X-Gate-Method", method);
			headers.set("X-Gate-Path", request.path);
			const response = await fetchImplementation(new URL("/api/gate/intents", baseUrl), { method: "POST", headers, body: new Uint8Array(body) });
			const responseBody = Buffer.from(await response.arrayBuffer());
			if (response.status === 402) return { authorized: false, status: 402, headers: response.headers, body: responseBody };
			if (!response.ok) throw new Error(`GATE authorization failed with HTTP ${response.status}`);
			const receipt = response.headers.get("gate-receipt") ?? parseReceipt(responseBody);
			if (receipt === null || options.routeId === undefined) throw new Error("GATE receipt verification failed");
			const claims = decodeReceiptClaims(receipt);
			if (claims === null) throw new Error("GATE receipt verification failed");
			const verified = verifyGateReceipt({
				receipt,
				publicKey: options.receiptPublicKey,
				issuer: baseUrl.origin,
				keyId: options.receiptKeyId,
				expected: { projectId: options.projectId, routeId: options.routeId, method, path: request.path, bodyDigest: createHash("sha256").update(body).digest("hex"), amountSats: claims.amount_sats, paymentHash: claims.payment_hash, jti: claims.jti },
				now: new Date(),
			});
			if (!verified.valid) throw new Error("GATE receipt verification failed");
			return { authorized: true, receipt, response: new Response(responseBody, { status: response.status, headers: response.headers }) };
		},
	};
}

function sanitizeHeaders(input?: HeadersInit): Headers {
	const headers = new Headers(input);
	for (const name of ["authorization", "gate-receipt", "x-gate-project", "x-gate-route", "x-gate-method", "x-gate-path", "x-gate-lightning-address", "idempotency-key"]) headers.delete(name);
	return headers;
}

function validatedBaseUrl(value: string): URL {
	const url = new URL(value);
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("GATE base URL must use HTTPS outside loopback development");
	return url;
}

function parseReceipt(body: Buffer): string | null {
	try { const parsed: unknown = JSON.parse(body.toString("utf8")); return typeof parsed === "object" && parsed !== null && typeof (parsed as { receipt?: unknown }).receipt === "string" ? (parsed as { receipt: string }).receipt : null; }
	catch { return null; }
}

function decodeReceiptClaims(receipt: string): { amount_sats: number; payment_hash: string; jti: string } | null {
	const claims = receipt.split(".")[1];
	if (claims === undefined) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as { amount_sats?: unknown; payment_hash?: unknown; jti?: unknown };
		return Number.isSafeInteger(value.amount_sats) && typeof value.amount_sats === "number" && typeof value.payment_hash === "string" && typeof value.jti === "string" ? { amount_sats: value.amount_sats, payment_hash: value.payment_hash, jti: value.jti } : null;
	} catch { return null; }
}
