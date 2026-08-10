import { afterEach, describe, expect, it, vi } from "vitest";

type FakeElement = { textContent: string; children: FakeElement[]; replaceChildren(...children: FakeElement[]): void };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("public stats browser", () => {
	it("renders a valid aggregate response", async () => {
		const elements = installDom();
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve(validStats()) }));
		await loadStatsModule();
		expect(elements.get("#stats-views")?.textContent).toBe("1,402");
		expect(elements.get("#stats-views-today")?.textContent).toBe("42");
		expect(elements.get("#stats-views-week")?.textContent).toBe("402");
		expect(elements.get("#stats-paid")?.textContent).toBe("5");
		expect(elements.get("#stats-dispensed")?.textContent).toBe("4");
		expect(elements.get("#stats-sats")?.textContent).toBe("570");
		expect(elements.get("#stats-products")?.children).toHaveLength(3);
		expect(elements.get("#stats-status")?.textContent).toContain("Aggregate counters loaded");
	});

	it("keeps placeholders and reports unavailability for an invalid contract", async () => {
		const elements = installDom();
		vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve({ paidPayments: 5, byProduct: {} }) }));
		await loadStatsModule();
		expect(elements.get("#stats-views")?.textContent).toBe("—");
		expect(elements.get("#stats-views-today")?.textContent).toBe("—");
		expect(elements.get("#stats-views-week")?.textContent).toBe("—");
		expect(elements.get("#stats-paid")?.textContent).toBe("—");
		expect(elements.get("#stats-dispensed")?.textContent).toBe("—");
		expect(elements.get("#stats-sats")?.textContent).toBe("—");
		expect(elements.get("#stats-products")?.children[0]?.textContent).toBe("Aggregate activity unavailable");
		expect(elements.get("#stats-status")?.textContent).toBe("Aggregate activity is temporarily unavailable.");
	});
});

function installDom(): Map<string, FakeElement> {
	const selectors = ["#stats-views", "#stats-views-today", "#stats-views-week", "#stats-paid", "#stats-dispensed", "#stats-sats", "#stats-products", "#stats-status"];
	const elements = new Map(selectors.map((selector) => [selector, fakeElement()]));
	vi.stubGlobal("document", {
		querySelector: (selector: string) => elements.get(selector) ?? null,
		createElement: () => fakeElement(),
	});
	return elements;
}

function fakeElement(): FakeElement {
	return { textContent: "—", children: [], replaceChildren(...children) { this.children = children; } };
}

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
		paidPayments: 5,
		dispensedResources: 4,
		receivedSats: 570,
		byProduct: {
			catch: { paidPayments: 2, dispensedResources: 2, receivedSats: 84 },
			whisper: { paidPayments: 2, dispensedResources: 1, receivedSats: 444 },
			pulse: { paidPayments: 1, dispensedResources: 1, receivedSats: 42 },
		},
	};
}