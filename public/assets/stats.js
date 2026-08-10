import { parsePublicStats } from "./stats-contract.js";

const views = document.querySelector("#stats-views");
const viewsToday = document.querySelector("#stats-views-today");
const viewsWeek = document.querySelector("#stats-views-week");
const paid = document.querySelector("#stats-paid");
const dispensed = document.querySelector("#stats-dispensed");
const sats = document.querySelector("#stats-sats");
const products = document.querySelector("#stats-products");
const status = document.querySelector("#stats-status");

const format = new Intl.NumberFormat("en-US");

try {
	const response = await fetch("/api/stats", { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error("stats unavailable");
	const data = parsePublicStats(await response.json());
	if (data === null) throw new Error("invalid stats response");
	const productItems = ["catch", "whisper", "pulse"].map((product) => {
		const item = document.createElement("span");
		const productStats = data.byProduct[product];
		item.textContent = `${product.toUpperCase()} · ${format.format(productStats.dispensedResources)} dispensed · ${format.format(productStats.receivedSats)} sats`;
		return item;
	});
	views.textContent = format.format(data.pageViews);
	viewsToday.textContent = format.format(data.viewsToday);
	viewsWeek.textContent = format.format(data.viewsLast7Days);
	paid.textContent = format.format(data.paidPayments);
	dispensed.textContent = format.format(data.dispensedResources);
	sats.textContent = format.format(data.receivedSats);
	products.replaceChildren(...productItems);
	status.textContent = "Aggregate counters loaded. Visits use daily totals only; payment figures update after settlement or dispensing.";
} catch {
	views.textContent = "—";
	viewsToday.textContent = "—";
	viewsWeek.textContent = "—";
	paid.textContent = "—";
	dispensed.textContent = "—";
	sats.textContent = "—";
	const unavailable = document.createElement("span");
	unavailable.textContent = "Aggregate activity unavailable";
	products.replaceChildren(unavailable);
	status.textContent = "Aggregate activity is temporarily unavailable.";
}
