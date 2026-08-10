import { afterEach, describe, expect, it, vi } from "vitest";

type FakeElement = { textContent: string; children: FakeElement[]; dataset: Record<string, string>; attributes: Record<string, string>; listeners: Record<string, Array<() => void>>; classList: { toggle(name: string, enabled: boolean): void }; replaceChildren(...children: FakeElement[]): void; setAttribute(name: string, value: string): void; addEventListener(name: string, listener: () => void): void; click(): void };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("public stats browser", () => {
	it("renders a valid aggregate funnel and activity history", async () => {
		const elements = installDom();
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve(validStats()) }));
		await loadStatsModule();
		expect(elements.get("#stats-views")?.textContent).toBe("1,402");
		expect(elements.get("#stats-views-today")?.textContent).toBe("42");
		expect(elements.get("#stats-views-week")?.textContent).toBe("402");
		expect(elements.get("#stats-quotes")?.textContent).toBe("8");
		expect(elements.get("#stats-paid")?.textContent).toBe("5");
		expect(elements.get("#stats-dispensed")?.textContent).toBe("4");
		expect(elements.get("#stats-sats")?.textContent).toBe("570");
		expect(elements.get("#stats-visit-quote")?.textContent).toBe("0.6%");
		expect(elements.get("#stats-quote-paid")?.textContent).toBe("62.5%");
		expect(elements.get("#stats-paid-dispensed")?.textContent).toBe("80%");
		expect(elements.get("#stats-products")?.children).toHaveLength(3);
		expect(elements.get("#stats-plans")?.children).toHaveLength(9);
		expect(elements.get("#stats-activity")?.children).toHaveLength(2);
		expect(elements.get("#stats-status")?.textContent).toContain("Historical order totals loaded");
		expect(elements.get("#stats-period-label")?.textContent).toBe("ALL TIME");
		expect(elements.get("#stats-period-all")?.attributes["aria-pressed"]).toBe("true");
		elements.get("#stats-period-today")?.click();
		expect(elements.get("#stats-views")?.textContent).toBe("42");
		expect(elements.get("#stats-quotes")?.textContent).toBe("3");
		expect(elements.get("#stats-paid")?.textContent).toBe("2");
		expect(elements.get("#stats-dispensed")?.textContent).toBe("2");
		expect(elements.get("#stats-sats")?.textContent).toBe("402");
		expect(elements.get("#stats-period-label")?.textContent).toBe("TODAY / UTC");
		expect(elements.get("#stats-period-today")?.attributes["aria-pressed"]).toBe("true");
		expect(elements.get("#stats-period-all")?.attributes["aria-pressed"]).toBe("false");
	});

	it("keeps placeholders and reports unavailability for an invalid contract", async () => {
		const elements = installDom();
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve({ paidPayments: 5, byProduct: {} }) }));
		await loadStatsModule();
		for (const selector of ["#stats-views", "#stats-views-today", "#stats-views-week", "#stats-quotes", "#stats-paid", "#stats-dispensed", "#stats-sats", "#stats-visit-quote", "#stats-quote-paid", "#stats-paid-dispensed"]) expect(elements.get(selector)?.textContent).toBe("—");
		expect(elements.get("#stats-products")?.children[0]?.textContent).toBe("Aggregate activity unavailable");
		expect(elements.get("#stats-status")?.textContent).toBe("Aggregate activity is temporarily unavailable.");
	});
});

function installDom(): Map<string, FakeElement> {
	const selectors = ["#stats-views", "#stats-views-today", "#stats-views-week", "#stats-quotes", "#stats-paid", "#stats-dispensed", "#stats-sats", "#stats-visit-quote", "#stats-quote-paid", "#stats-paid-dispensed", "#stats-products", "#stats-plans", "#stats-activity", "#stats-status", "#stats-period-label", "#stats-period-all", "#stats-period-today", "#stats-period-7d", "#stats-period-30d"];
	const elements = new Map(selectors.map((selector) => [selector, fakeElement()]));
	elements.get("#stats-period-all")!.dataset.statsPeriod = "all";
	elements.get("#stats-period-today")!.dataset.statsPeriod = "today";
	elements.get("#stats-period-7d")!.dataset.statsPeriod = "last7Days";
	elements.get("#stats-period-30d")!.dataset.statsPeriod = "last30Days";
	vi.stubGlobal("document", { querySelector: (selector: string) => elements.get(selector) ?? null, createElement: () => fakeElement() });
	return elements;
}

function fakeElement(): FakeElement { return { textContent: "—", children: [], dataset: {}, attributes: {}, listeners: {}, classList: { toggle() {} }, replaceChildren(...children) { this.children = children; }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }, click() { for (const listener of this.listeners.click ?? []) listener(); } }; }
async function loadStatsModule(): Promise<void> {
	vi.resetModules();
	// @ts-expect-error The browser module intentionally ships as plain JavaScript.
	await import("../../public/assets/stats.js");
}

function validStats() {
	return {
		pageViews: 1_402,
		viewsToday: 42,
		viewsLast7Days: 402,
		quotesIssued: 8,
		paidPayments: 5,
		dispensedResources: 4,
		receivedSats: 570,
		periods: {
			all: { pageViews: 1_402, quotesIssued: 8, paidPayments: 5, dispensedResources: 4, receivedSats: 570 },
			today: { pageViews: 42, quotesIssued: 3, paidPayments: 2, dispensedResources: 2, receivedSats: 402 },
			last7Days: { pageViews: 402, quotesIssued: 6, paidPayments: 4, dispensedResources: 3, receivedSats: 528 },
			last30Days: { pageViews: 610, quotesIssued: 7, paidPayments: 4, dispensedResources: 3, receivedSats: 528 },
		},
		funnel: { trackingStartedOn: "2026-08-09", pageViews: 1_402, quotesIssued: 8, paidPayments: 5, dispensedResources: 4, visitToQuotePercent: 0.6, quoteToPaidPercent: 62.5, paidToDispensedPercent: 80 },
		activityLast30Days: [
			{ day: "2026-08-09", pageViews: 12, quotesIssued: 2, paidPayments: 1, dispensedResources: 1 },
			{ day: "2026-08-10", pageViews: 42, quotesIssued: 3, paidPayments: 2, dispensedResources: 2 },
		],
		byProduct: { catch: productStats(3, 2, 2, 84), whisper: productStats(3, 2, 1, 444), pulse: productStats(2, 1, 1, 42) },
	};
}

function productStats(quotesIssued: number, paidPayments: number, dispensedResources: number, receivedSats: number) {
	const empty = { quotesIssued: 0, paidPayments: 0, dispensedResources: 0, receivedSats: 0 };
	return { quotesIssued, paidPayments, dispensedResources, receivedSats, byPlan: { spark: { ...empty }, standard: { ...empty }, long: { ...empty } } };
}
