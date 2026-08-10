const PRODUCTS = ["catch", "whisper", "pulse"];
const COUNTERS = ["paidPayments", "dispensedResources", "receivedSats"];

export function parsePublicStats(value) {
	if (!isRecord(value) || !isRecord(value.byProduct) || !COUNTERS.every((counter) => isCounter(value[counter]))) return null;
	for (const product of PRODUCTS) {
		const productStats = value.byProduct[product];
		if (!isRecord(productStats) || !COUNTERS.every((counter) => isCounter(productStats[counter]))) return null;
	}
	return value;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounter(value) {
	return Number.isSafeInteger(value) && value >= 0;
}