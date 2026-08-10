const PRODUCTS = ["catch", "whisper", "pulse"];
const PLANS = ["spark", "standard", "long"];
const COUNTERS = ["quotesIssued", "paidPayments", "dispensedResources", "receivedSats"];
const TRAFFIC_COUNTERS = ["pageViews", "viewsToday", "viewsLast7Days"];
const FUNNEL_COUNTERS = ["pageViews", "quotesIssued", "paidPayments", "dispensedResources"];
const CONVERSIONS = ["visitToQuotePercent", "quoteToPaidPercent", "paidToDispensedPercent"];

export function parsePublicStats(value) {
	if (!isRecord(value) || !isRecord(value.byProduct) || !isRecord(value.funnel) || !Array.isArray(value.activityLast30Days)) return null;
	if (![...TRAFFIC_COUNTERS, ...COUNTERS].every((counter) => isCounter(value[counter]))) return null;
	if (!FUNNEL_COUNTERS.every((counter) => isCounter(value.funnel[counter])) || !CONVERSIONS.every((counter) => isPercentage(value.funnel[counter]))) return null;
	if (!(value.funnel.trackingStartedOn === null || isDay(value.funnel.trackingStartedOn))) return null;
	for (const product of PRODUCTS) {
		const productStats = value.byProduct[product];
		if (!isRecord(productStats) || !isRecord(productStats.byPlan) || !COUNTERS.every((counter) => isCounter(productStats[counter]))) return null;
		for (const plan of PLANS) if (!isRecord(productStats.byPlan[plan]) || !COUNTERS.every((counter) => isCounter(productStats.byPlan[plan][counter]))) return null;
	}
	if (value.activityLast30Days.length > 30 || !value.activityLast30Days.every((day) => isRecord(day) && isDay(day.day) && ["pageViews", "quotesIssued", "paidPayments", "dispensedResources"].every((counter) => isCounter(day[counter])))) return null;
	return value;
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isCounter(value) { return Number.isSafeInteger(value) && value >= 0; }
function isPercentage(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isDay(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value); }
