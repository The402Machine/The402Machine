import { parsePublicStats } from "./stats-contract.js";

const selectors = ["views", "views-today", "views-week", "quotes", "paid", "dispensed", "sats", "visit-quote", "quote-paid", "paid-dispensed", "products", "plans", "activity", "status", "period-label"];
const elements = Object.fromEntries(selectors.map((name) => [name, document.querySelector(`#stats-${name}`)]));
const periodButtons = ["all", "today", "7d", "30d"].map((name) => document.querySelector(`#stats-period-${name}`)).filter(Boolean);
const format = new Intl.NumberFormat("en-US");
const PRODUCTS = ["catch", "whisper", "pulse"];
const PLANS = ["spark", "standard", "long"];
const PERIOD_LABELS = { all: "ALL TIME", today: "TODAY / UTC", last7Days: "LAST 7 DAYS", last30Days: "LAST 30 DAYS" };

try {
	const response = await fetch("/api/stats", { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error("stats unavailable");
	const data = parsePublicStats(await response.json());
	if (data === null) throw new Error("invalid stats response");
	const renderPeriod = (periodName) => {
		const period = data.periods[periodName];
		if (period === undefined) return;
		elements.views.textContent = format.format(period.pageViews);
		elements.quotes.textContent = format.format(period.quotesIssued);
		elements.paid.textContent = format.format(period.paidPayments);
		elements.dispensed.textContent = format.format(period.dispensedResources);
		elements.sats.textContent = format.format(period.receivedSats);
		elements["visit-quote"].textContent = formatPercent(conversion(period.quotesIssued, period.pageViews));
		elements["quote-paid"].textContent = formatPercent(conversion(period.paidPayments, period.quotesIssued));
		elements["paid-dispensed"].textContent = formatPercent(conversion(period.dispensedResources, period.paidPayments));
		elements["period-label"].textContent = PERIOD_LABELS[periodName];
		for (const button of periodButtons) {
			const selected = button.dataset.statsPeriod === periodName;
			button.setAttribute("aria-pressed", String(selected));
			button.classList.toggle("active", selected);
		}
	};
	elements["views-today"].textContent = format.format(data.viewsToday);
	elements["views-week"].textContent = format.format(data.viewsLast7Days);
	for (const button of periodButtons) button.addEventListener("click", () => renderPeriod(button.dataset.statsPeriod));
	renderPeriod("all");
	elements.products.replaceChildren(...PRODUCTS.map((product) => textItem(`${product.toUpperCase()} · ${format.format(data.byProduct[product].quotesIssued)} quotes · ${format.format(data.byProduct[product].dispensedResources)} dispensed · ${format.format(data.byProduct[product].receivedSats)} sats`)));
	elements.plans.replaceChildren(...PRODUCTS.flatMap((product) => PLANS.map((plan) => {
		const stats = data.byProduct[product].byPlan[plan];
		return textItem(`${product.toUpperCase()} / ${plan.toUpperCase()} · ${format.format(stats.quotesIssued)} quotes · ${format.format(stats.paidPayments)} paid · ${format.format(stats.dispensedResources)} dispensed`);
	})));
	const visibleActivity = data.activityLast30Days.filter((day) => day.pageViews + day.quotesIssued + day.paidPayments + day.dispensedResources > 0);
	elements.activity.replaceChildren(...visibleActivity.map((day) => textItem(`${day.day} · ${format.format(day.pageViews)} views · ${format.format(day.quotesIssued)} quotes · ${format.format(day.paidPayments)} paid · ${format.format(day.dispensedResources)} dispensed`)));
	if (visibleActivity.length === 0) elements.activity.replaceChildren(textItem("No aggregate activity in the last 30 days"));
	elements.status.textContent = `Historical order totals loaded. Page views are available since ${data.funnel.trackingStartedOn ?? "the counter was enabled"}; periods that begin earlier contain only the available page-view portion. No visitor identities are retained.`;
} catch {
	for (const name of ["views", "views-today", "views-week", "quotes", "paid", "dispensed", "sats", "visit-quote", "quote-paid", "paid-dispensed"]) elements[name].textContent = "—";
	const unavailable = textItem("Aggregate activity unavailable");
	elements.products.replaceChildren(unavailable);
	elements.plans.replaceChildren();
	elements.activity.replaceChildren();
	elements.status.textContent = "Aggregate activity is temporarily unavailable.";
}

function textItem(value) { const item = document.createElement("span"); item.textContent = value; return item; }
function formatPercent(value) { return `${format.format(value)}%`; }
function conversion(numerator, denominator) { return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1)); }
