import { createHash } from "node:crypto";

import { decode } from "bolt11-ts";

export type ValidatedBolt11 = { paymentHash: string; amountSats: number; network: "mainnet" | "regtest" | "signet"; expiresAt: Date };

export async function validateBolt11(input: { bolt11: string; expectedPaymentHash: string; expectedAmountSats: number; expectedDescriptionHash?: string }): Promise<ValidatedBolt11> {
	let invoice;
	try {
		invoice = await decode(input.bolt11);
	} catch {
		throw new Error("Lightning invoice is not valid BOLT11");
	}
	const paymentHash = invoice.tagsObject.payment_hash;
	if (paymentHash !== input.expectedPaymentHash) throw new Error("Lightning invoice payment hash mismatch");
	if (invoice.satoshis !== input.expectedAmountSats) throw new Error("Lightning invoice amount mismatch");
	if (input.expectedDescriptionHash !== undefined) {
		const expectedHash = createHash("sha256").update(input.expectedDescriptionHash, "utf8").digest("hex");
		if (invoice.tagsObject.purpose_commit_hash !== expectedHash) throw new Error("Lightning invoice description hash mismatch");
	}
	const network = networkName(invoice.prefix);
	if (network === null) throw new Error("Lightning invoice network is unsupported");
	if (invoice.timeExpireDate === null) throw new Error("Lightning invoice expiry is missing");
	const expiresAt = new Date(invoice.timeExpireDate * 1_000);
	if (!Number.isFinite(expiresAt.getTime())) throw new Error("Lightning invoice expiry is invalid");
	if (expiresAt.getTime() <= Date.now()) throw new Error("Lightning invoice is already expired");
	return { paymentHash, amountSats: input.expectedAmountSats, network, expiresAt };
}

function networkName(prefix: string): ValidatedBolt11["network"] | null {
	if (prefix.startsWith("lnbcrt")) return "regtest";
	if (prefix.startsWith("lntbs")) return "signet";
	if (prefix.startsWith("lnbc")) return "mainnet";
	return null;
}
