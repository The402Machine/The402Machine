import { describe, expect, it } from "vitest";

import { clearPendingCheckout, loadPendingCheckout, savePendingCheckout } from "../public/assets/checkout-session.js";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

describe("pending checkout session", () => {
	it("stores only the pending invoice state needed to resume", () => {
		const storage = memoryStorage();
		const pending = {
			version: 1 as const,
			product: "catch" as const,
			planId: "spark" as const,
			idempotencyKey: "pending-catch-key",
			orderId: "14d98d8e-731c-4e72-95d3-262604586986",
			bolt11: "lnbc42n1pending",
			amountSats: 42,
			expiresAt: "2026-08-10T05:00:00.000Z",
		};
		savePendingCheckout(storage, pending);
		expect(loadPendingCheckout(storage, new Date("2026-08-10T04:55:00.000Z"))).toEqual(pending);
		expect(storage.dump()).not.toMatch(/ownerToken|readToken|ingestToken|pingToken|delivery|resource/iu);
	});

	it("keeps the WHISPER key and ciphertext only for its unfinished encrypted purchase", () => {
		const storage = memoryStorage();
		const pending = {
			version: 1 as const,
			product: "whisper" as const,
			planId: "standard" as const,
			idempotencyKey: "pending-whisper-key",
			orderId: "02b885a4-663b-4e4d-ae13-d5dc3c58e3ea",
			bolt11: "lnbc402n1pending",
			amountSats: 402,
			expiresAt: "2026-08-10T05:00:00.000Z",
			encryptionKey: "private-browser-key",
			ciphertext: "AQIDBA",
			readLimit: 12,
			revealAt: "2026-08-11T05:00:00.000Z",
		};
		savePendingCheckout(storage, pending);
		expect(loadPendingCheckout(storage, new Date("2026-08-10T04:55:00.000Z"))).toEqual(pending);
	});

	it("deletes expired, malformed, and completed pending purchases", () => {
		const storage = memoryStorage();
		storage.setItem("the402machine.pending-checkout.v1", JSON.stringify({ version: 1, product: "catch", planId: "spark", idempotencyKey: "bad", orderId: "order", bolt11: "invoice", amountSats: 42, expiresAt: "2026-08-10T04:00:00.000Z" }));
		expect(loadPendingCheckout(storage, new Date("2026-08-10T04:55:00.000Z"))).toBeNull();
		expect(storage.dump()).toBe("");
		savePendingCheckout(storage, { version: 1, product: "pulse", planId: "long", idempotencyKey: "pending-pulse-key", orderId: "a30d7771-76e2-4cab-b31c-45348ed9e0f7", bolt11: "lnbc4002n1pending", amountSats: 4002, expiresAt: "2026-08-10T05:00:00.000Z" });
		clearPendingCheckout(storage);
		expect(loadPendingCheckout(storage)).toBeNull();
	});
});

function memoryStorage(): StorageLike & { dump(): string } {
	const entries = new Map<string, string>();
	return {
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => { entries.set(key, value); },
		removeItem: (key) => { entries.delete(key); },
		dump: () => [...entries.values()].join("\n"),
	};
}
