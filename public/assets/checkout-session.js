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
	if (![value.orderId, value.bolt11].every((entry) => typeof entry === "string" && entry.length >= 8)) return false;
	if (!Number.isSafeInteger(value.amountSats) || value.amountSats <= 0 || !isDateShape(value.expiresAt)) return false;
	const common = ["version", "product", "planId", "orderId", "bolt11", "amountSats", "expiresAt"];
	if (value.product !== "whisper") return Object.keys(value).every((key) => common.includes(key));
	if (typeof value.encryptionKey !== "string" || value.encryptionKey.length < 6) return false;
	return Object.keys(value).every((key) => [...common, "encryptionKey"].includes(key));
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isDateShape(value) { return typeof value === "string" && Number.isFinite(new Date(value).getTime()); }
