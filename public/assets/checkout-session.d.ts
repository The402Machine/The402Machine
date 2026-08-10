export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PendingProduct = "catch" | "whisper" | "pulse";
export type PendingPlan = "spark" | "standard" | "long";
export type CommonPendingCheckout = {
	version: 1;
	product: PendingProduct;
	planId: PendingPlan;
	orderId: string;
	bolt11: string;
	amountSats: number;
	expiresAt: string;
};
export type PendingCheckout = CommonPendingCheckout | (CommonPendingCheckout & {
	product: "whisper";
	encryptionKey: string;
});
export function savePendingCheckout(storage: StorageLike, pending: PendingCheckout): void;
export function loadPendingCheckout(storage: StorageLike, now?: Date): PendingCheckout | null;
export function clearPendingCheckout(storage: StorageLike): void;
