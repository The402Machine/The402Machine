const STORAGE_KEY = "the402machine.pending-checkout.v1";
const PRODUCTS = new Set(["catch", "whisper", "pulse"]);
const PLANS = new Set(["spark", "standard", "long"]);

export function savePendingCheckout(storage, pending) {
	if (!isPendingCheckout(pending)) throw new Error("Pending checkout state is invalid");
	storage.setItem(STORAGE_KEY, JSON.stringify(pending));
}

export function loadPendingCheckout(storage, now = new Date()) {
	let parsed;
	try {
		const value = storage.getItem(STORAGE_KEY);
		if (value === null) return null;
		parsed = JSON.parse(value);
	} catch {
		storage.removeItem(STORAGE_KEY);
		return null;
	}
	if (!isPendingCheckout(parsed) || new Date(parsed.expiresAt).getTime() <= now.getTime()) {
		storage.removeItem(STORAGE_KEY);
		return null;
	}
	return parsed;
}

export function clearPendingCheckout(storage) {
	storage.removeItem(STORAGE_KEY);
}

function isPendingCheckout(value) {
	if (!isRecord(value) || value.version !== 1 || !PRODUCTS.has(value.product) || !PLANS.has(value.planId)) return false;
	if (![value.idempotencyKey, value.orderId, value.bolt11].every((entry) => typeof entry === "string" && entry.length >= 8)) return false;
	if (!Number.isSafeInteger(value.amountSats) || value.amountSats <= 0 || !isFutureDateShape(value.expiresAt)) return false;
	const keys = Object.keys(value);
	const common = ["version", "product", "planId", "idempotencyKey", "orderId", "bolt11", "amountSats", "expiresAt"];
	if (value.product !== "whisper") return keys.every((key) => common.includes(key));
	if (![value.encryptionKey, value.ciphertext].every((entry) => typeof entry === "string" && entry.length >= 6)) return false;
	if (!Number.isSafeInteger(value.readLimit) || value.readLimit < 1 || !(value.revealAt === null || isFutureDateShape(value.revealAt))) return false;
	return keys.every((key) => [...common, "encryptionKey", "ciphertext", "readLimit", "revealAt"].includes(key));
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isFutureDateShape(value) { return typeof value === "string" && Number.isFinite(new Date(value).getTime()); }
