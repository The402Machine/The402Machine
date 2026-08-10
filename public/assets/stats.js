import { parsePublicStats } from "./stats-contract.js";

const selectors = ["views", "views-today", "views-week", "quotes", "paid", "dispensed", "sats", "visit-quote", "quote-paid", "paid-dispensed", "products", "plans", "activity", "status"];
const elements = Object.fromEntries(selectors.map((name) => [name, document.querySelector(`#stats-${name}`)]));
const format = new Intl.NumberFormat("en-US");
const PRODUCTS = ["catch", "whisper", "pulse"];
const PLANS = ["spark", "standard", "long"];

try {
	const response = await fetch("/api/stats", { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error("stats unavailable");
	const data = parsePublicStats(await response.json());
	if (data === null) throw new Error("invalid stats response");
	elements.views.textContent = format.format(data.pageViews);
	elements["views-today"].textContent = format.format(data.viewsToday);
	elements["views-week"].textContent = format.format(data.viewsLast7Days);
	elements.quotes.textContent = format.format(data.quotesIssued);
	elements.paid.textContent = format.format(data.paidPayments);
	elements.dispensed.textContent = format.format(data.dispensedResources);
	elements.sats.textContent = format.format(data.receivedSats);
	elements["visit-quote"].textContent = formatPercent(data.funnel.visitToQuotePercent);
	elements["quote-paid"].textContent = formatPercent(data.funnel.quoteToPaidPercent);
	elements["paid-dispensed"].textContent = formatPercent(data.funnel.paidToDispensedPercent);
	elements.products.replaceChildren(...PRODUCTS.map((product) => textItem(`${product.toUpperCase()} · ${format.format(data.byProduct[product].quotesIssued)} quotes · ${format.format(data.byProduct[product].dispensedResources)} dispensed · ${format.format(data.byProduct[product].receivedSats)} sats`)));
	elements.plans.replaceChildren(...PRODUCTS.flatMap((product) => PLANS.map((plan) => {
		const stats = data.byProduct[product].byPlan[plan];
		return textItem(`${product.toUpperCase()} / ${plan.toUpperCase()} · ${format.format(stats.quotesIssued)} quotes · ${format.format(stats.paidPayments)} paid · ${format.format(stats.dispensedResources)} dispensed`);
	})));
	const visibleActivity = data.activityLast30Days.filter((day) => day.pageViews + day.quotesIssued + day.paidPayments + day.dispensedResources > 0);
	elements.activity.replaceChildren(...visibleActivity.map((day) => textItem(`${day.day} · ${format.format(day.pageViews)} views · ${format.format(day.quotesIssued)} quotes · ${format.format(day.paidPayments)} paid · ${format.format(day.dispensedResources)} dispensed`)));
	if (visibleActivity.length === 0) elements.activity.replaceChildren(textItem("No aggregate activity in the last 30 days"));
	elements.status.textContent = `Aggregate funnel loaded. Visit conversion uses page views recorded since ${data.funnel.trackingStartedOn ?? "the counter was enabled"}; no visitor identities are retained.`;
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
