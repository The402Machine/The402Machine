import { sealWhisper, whisperLink } from "/assets/whisper.js";

const dialog = document.querySelector("#checkout");
const form = document.querySelector("#checkout-form");
const title = document.querySelector("#checkout-title");
const intro = document.querySelector("#checkout-intro");
const planChoices = document.querySelector("#checkout-plans");
const summary = document.querySelector("#checkout-summary");
const noteField = document.querySelector("#whisper-note-field");
const note = document.querySelector("#whisper-note");
const status = document.querySelector("#checkout-status");
const output = document.querySelector("#checkout-output");
const closeButton = document.querySelector("#checkout-close");
const submitButton = document.querySelector("#checkout-submit");
const indicator = document.querySelector("#checkout-indicator");

if (!(dialog instanceof HTMLDialogElement) || !(form instanceof HTMLFormElement) || !(title instanceof HTMLElement) || !(intro instanceof HTMLElement) || !(planChoices instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(noteField instanceof HTMLElement) || !(note instanceof HTMLTextAreaElement) || !(status instanceof HTMLElement) || !(output instanceof HTMLTextAreaElement) || !(closeButton instanceof HTMLButtonElement) || !(submitButton instanceof HTMLButtonElement) || !(indicator instanceof HTMLElement)) throw new Error("Checkout is incomplete");

let catalog = null;
let product = "catch";
let selectedPlanId = "standard";
let encryptionKey = "";

void configureCheckout();

async function configureCheckout() {
	try {
		const response = await fetch("/api/catalog", { cache: "no-store" });
		const received = await response.json();
		if (!response.ok || received.checkoutEnabled !== true || !isCatalog(received)) throw new Error("disabled");
		catalog = received;
		indicator.textContent = "LIGHTNING CHECKOUT ONLINE";
		indicator.closest(".eyebrow")?.classList.add("online");
	} catch {
		disableCheckout();
	}
}

function disableCheckout() {
	catalog = null;
	indicator.textContent = "LIGHTNING CHECKOUT OFFLINE";
	document.querySelectorAll("[data-buy]").forEach((button) => {
		if (button instanceof HTMLButtonElement) {
			button.disabled = true;
			button.textContent = "Checkout disabled";
		}
	});
}

function isCatalog(value) {
	return value?.products?.catch?.plans instanceof Array && value?.products?.whisper?.plans instanceof Array;
}

document.querySelectorAll("[data-buy]").forEach((button) => button.addEventListener("click", () => {
	if (!(button instanceof HTMLButtonElement) || catalog === null) return;
	product = button.dataset.buy === "whisper" ? "whisper" : "catch";
	selectedPlanId = isPlanId(button.dataset.plan) ? button.dataset.plan : "standard";
	openCheckout();
}));

function openCheckout() {
	const productData = catalog.products[product];
	title.textContent = `Dispense ${product.toUpperCase()}`;
	intro.textContent = product === "catch"
		? "Choose by lifetime, request quota, and storage. Every CATCH stays inbound-only."
		: "Choose how long the unread message should wait. Every WHISPER is still read once and encrypted in this browser.";
	noteField.hidden = product !== "whisper";
	note.required = product === "whisper";
	output.hidden = true;
	output.value = "";
	encryptionKey = "";
	renderPlanChoices(productData.plans);
	updateSummary();
	status.textContent = "Review the plan, then create the Lightning invoice.";
	dialog.showModal();
}

function renderPlanChoices(plans) {
	planChoices.replaceChildren(...plans.filter((plan) => plan.available).map((plan) => {
		const label = document.createElement("label");
		label.className = "checkout-plan";
		const input = document.createElement("input");
		input.type = "radio";
		input.name = "planId";
		input.value = plan.planId;
		input.checked = plan.planId === selectedPlanId;
		input.addEventListener("change", () => { selectedPlanId = plan.planId; updateSummary(); });
		const copy = document.createElement("span");
		copy.innerHTML = `<b>${plan.planId.toUpperCase()}</b><strong>${formatSats(plan.priceSats)} sats</strong><small>${plan.durationLabel} · ${plan.bestFor}</small>`;
		label.append(input, copy);
		return label;
	}));
}

function updateSummary() {
	const plan = selectedPlan();
	if (plan === null) return;
	const details = product === "catch"
		? `${formatNumber(plan.requestLimit)} requests · ${formatBytes(plan.storageLimitBytes)} total storage · ${formatBytes(plan.maxBytesPerRequest)} per request`
		: `One successful read · ${formatBytes(plan.maxCiphertextBytes)} encrypted payload · key stays in the URL fragment`;
	summary.innerHTML = `<div><span>${product.toUpperCase()} / ${plan.planId.toUpperCase()}</span><strong>${formatSats(plan.priceSats)} sats</strong></div><p>${plan.durationLabel}. ${details}.</p>`;
}

closeButton.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const plan = selectedPlan();
	if (plan === null) return;
	const idempotencyKey = crypto.randomUUID();
	let response;
	submitButton.disabled = true;
	try {
		const catalogResponse = await fetch("/api/catalog", { cache: "no-store" });
		const currentCatalog = await catalogResponse.json();
		if (!catalogResponse.ok || currentCatalog.checkoutEnabled !== true || !isCatalog(currentCatalog)) throw new Error("Public Lightning checkout is currently disabled.");
		const currentPlan = currentCatalog.products[product].plans.find((candidate) => candidate.planId === selectedPlanId && candidate.available === true);
		if (currentPlan === undefined || currentPlan.priceSats !== plan.priceSats) throw new Error("This plan changed. Close checkout and review the current catalogue.");
		status.textContent = "Requesting a Lightning invoice…";
		if (product === "whisper") {
			const sealed = await sealWhisper(note.value);
			encryptionKey = sealed.key;
			response = await fetch("/api/payments/whisper", { method: "POST", headers: { "content-type": "application/octet-stream", "idempotency-key": idempotencyKey, "x-whisper-plan": selectedPlanId }, body: sealed.ciphertext });
		} else {
			response = await fetch("/api/payments/catch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ planId: selectedPlanId }) });
		}
		const quote = await response.json();
		if (response.status !== 402 || typeof quote.orderId !== "string" || typeof quote.bolt11 !== "string" || quote.amountSats !== plan.priceSats) throw new Error("The payment slot is unavailable.");
		output.value = quote.bolt11;
		output.hidden = false;
		status.textContent = `${formatSats(quote.amountSats)} sats. Pay this invoice; the machine will dispense automatically.`;
		await pollDelivery(quote.orderId);
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Checkout failed.";
	} finally {
		submitButton.disabled = false;
	}
});

function selectedPlan() {
	if (catalog === null) return null;
	return catalog.products[product].plans.find((plan) => plan.planId === selectedPlanId && plan.available === true) ?? null;
}

async function pollDelivery(orderId) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const response = await fetch(`/api/payments/${encodeURIComponent(orderId)}`, { cache: "no-store" });
		if (response.status === 402) continue;
		if (!response.ok) throw new Error("Could not verify payment.");
		const result = await response.json();
		if (!result.settled || !result.resource) continue;
		const resource = result.resource;
		output.value = resource.product === "whisper"
			? whisperLink(location.origin, resource.publicId, resource.readToken, encryptionKey)
			: JSON.stringify({ ingestUrl: `${location.origin}/c/${resource.publicId}`, ingestToken: resource.ingestToken, ownerToken: resource.ownerToken, eventsUrl: `${location.origin}/api/catch/${resource.publicId}/events`, expiresAt: resource.expiresAt }, null, 2);
		status.textContent = "Dispensed. Copy this now; no account can recover it for you.";
		return;
	}
	throw new Error("Invoice still unpaid or expired.");
}

function isPlanId(value) { return value === "spark" || value === "standard" || value === "long"; }
function formatSats(value) { return new Intl.NumberFormat("en-US").format(value); }
function formatNumber(value) { return new Intl.NumberFormat("en-US").format(value); }
function formatBytes(value) { return value >= 1024 * 1024 ? `${value / (1024 * 1024)} MiB` : `${value / 1024} KiB`; }
