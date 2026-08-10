#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";

const [baseUrl = "http://127.0.0.1:4020", protocol = "payment", product = "pulse", planId = "spark"] = process.argv.slice(2);
if (!new Set(["payment", "l402"]).has(protocol)) throw new Error("protocol must be payment or l402");
if (!new Set(["catch", "pulse"]).has(product)) throw new Error("this minimal example supports catch or pulse");

process.umask(0o077); // Equivalent to shell: umask 077
const idempotencyKey = `agent-example-${crypto.randomUUID()}`;
const body = JSON.stringify({ planId });
const endpoint = `${baseUrl.replace(/\/$/u, "")}/api/payments/${product}`;
const challengeResponse = await fetch(endpoint, {
	method: "POST",
	headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Payment-Protocol": protocol },
	body,
});
if (challengeResponse.status !== 402) throw new Error(`Expected HTTP 402 challenge, received ${challengeResponse.status}`);
const challengeHeader = challengeResponse.headers.get("www-authenticate");
if (challengeHeader === null) throw new Error("The server did not return WWW-Authenticate");

const invoice = protocol === "payment" ? paymentInvoice(challengeHeader) : l402Invoice(challengeHeader);
await writePrivateJson("invoice.json", { protocol, product, planId, invoice });
console.error("Invoice saved to invoice.json with mode 0600. Pay only with explicit authorization, then set PAYMENT_PREIMAGE_HEX locally.");

const preimage = process.env.PAYMENT_PREIMAGE_HEX;
if (preimage === undefined) process.exit(0);
if (!/^[a-f0-9]{64}$/u.test(preimage)) throw new Error("PAYMENT_PREIMAGE_HEX must be a lowercase 32-byte hex value");

const authorization = protocol === "payment"
	? paymentAuthorization(challengeHeader, preimage)
	: `L402 ${l402Macaroon(challengeHeader)}:${preimage}`;
const fulfilled = await fetch(endpoint, {
	method: "POST",
	headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Payment-Protocol": protocol, Authorization: authorization },
	body,
});
const responseBody = await fulfilled.json();
if (!fulfilled.ok) throw new Error(`Fulfillment failed with HTTP ${fulfilled.status}`);
if (!isDelivery(responseBody)) throw new Error("Fulfillment response has no delivered resource");
await writePrivateJson("capability.json", responseBody);
console.error(`Capability saved to capability.json with mode 0600. Delivered product: ${responseBody.resource.product}.`);

async function writePrivateJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600); // Equivalent to shell: chmod 600
}

function isDelivery(value) {
	return typeof value === "object" && value !== null && value.settled === true && typeof value.resource === "object" && value.resource !== null && new Set(["catch", "whisper", "pulse"]).has(value.resource.product);
}

function paymentInvoice(header) {
	const request = authParameter(header, "request");
	const decoded = JSON.parse(Buffer.from(request, "base64url").toString("utf8"));
	return decoded.methodDetails.invoice;
}

function l402Invoice(header) { return authParameter(header, "invoice"); }
function l402Macaroon(header) { return authParameter(header, "macaroon"); }

function paymentAuthorization(header, preimage) {
	const challenge = Object.fromEntries(["id", "realm", "method", "intent", "request", "digest", "expires", "opaque"].flatMap((name) => {
		const value = optionalAuthParameter(header, name);
		return value === undefined ? [] : [[name, value]];
	}));
	const token = Buffer.from(canonicalJson({ challenge, payload: { preimage } }), "utf8").toString("base64url");
	if (createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== JSON.parse(Buffer.from(challenge.request, "base64url").toString("utf8")).methodDetails.paymentHash) throw new Error("Preimage does not match challenge payment hash");
	return `Payment ${token}`;
}

function authParameter(header, name) {
	const value = optionalAuthParameter(header, name);
	if (value === undefined) throw new Error(`Challenge has no ${name} parameter`);
	return value;
}

function optionalAuthParameter(header, name) {
	return new RegExp(`(?:^|,\\s*)${name}="((?:\\\\.|[^"])*)"`, "u").exec(header.replace(/^\w+\s+/u, ""))?.[1]?.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function canonicalJson(value) {
	if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
