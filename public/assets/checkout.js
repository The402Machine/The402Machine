import { sealWhisper, whisperLink } from "/assets/whisper.js";
import { renderQr } from "/assets/qr-browser-v3.js";
import { requestProvider } from "/assets/webln-browser.js";

const dialog = document.querySelector("#checkout");
const form = document.querySelector("#checkout-form");
const title = document.querySelector("#checkout-title");
const intro = document.querySelector("#checkout-intro");
const planChoices = document.querySelector("#checkout-plans");
const summary = document.querySelector("#checkout-summary");
const noteField = document.querySelector("#whisper-note-field");
const note = document.querySelector("#whisper-note");
const scheduleField = document.querySelector("#whisper-schedule-field");
const revealAtInput = document.querySelector("#whisper-reveal-at");
const burnField = document.querySelector("#whisper-burn-field");
const burnAfterRead = document.querySelector("#whisper-burn-after-read");
const status = document.querySelector("#checkout-status");
const output = document.querySelector("#checkout-output");
const closeButton = document.querySelector("#checkout-close");
const submitButton = document.querySelector("#checkout-submit");
const indicator = document.querySelector("#checkout-indicator");
const paymentPanel = document.querySelector("#checkout-payment");
const progress = document.querySelector("#checkout-progress");
const qr = document.querySelector("#checkout-qr");
const amount = document.querySelector("#checkout-amount");
const walletLink = document.querySelector("#checkout-wallet");
const webLnButton = document.querySelector("#checkout-webln");
const copyButton = document.querySelector("#checkout-copy");
const invoice = document.querySelector("#checkout-invoice");
const deliveryActions = document.querySelector("#checkout-delivery-actions");
const portalLink = document.querySelector("#checkout-portal");
const copyPortalButton = document.querySelector("#checkout-copy-portal");
const portalNote = document.querySelector("#checkout-portal-note");

if (!(dialog instanceof HTMLDialogElement) || !(form instanceof HTMLFormElement) || !(title instanceof HTMLElement) || !(intro instanceof HTMLElement) || !(planChoices instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(noteField instanceof HTMLElement) || !(note instanceof HTMLTextAreaElement) || !(scheduleField instanceof HTMLElement) || !(revealAtInput instanceof HTMLInputElement) || !(burnField instanceof HTMLElement) || !(burnAfterRead instanceof HTMLInputElement) || !(status instanceof HTMLElement) || !(output instanceof HTMLTextAreaElement) || !(closeButton instanceof HTMLButtonElement) || !(submitButton instanceof HTMLButtonElement) || !(indicator instanceof HTMLElement) || !(paymentPanel instanceof HTMLElement) || !(progress instanceof HTMLElement) || !(qr instanceof HTMLElement) || !(amount instanceof HTMLElement) || !(walletLink instanceof HTMLAnchorElement) || !(webLnButton instanceof HTMLButtonElement) || !(copyButton instanceof HTMLButtonElement) || !(invoice instanceof HTMLTextAreaElement) || !(deliveryActions instanceof HTMLElement) || !(portalLink instanceof HTMLAnchorElement) || !(copyPortalButton instanceof HTMLButtonElement) || !(portalNote instanceof HTMLElement)) throw new Error("Checkout is incomplete");

let catalog = null;
let product = "catch";
let selectedPlanId = "standard";
let encryptionKey = "";
let currentInvoice = "";
let currentPortalUrl = "";
let checkoutSession = 0;
let deliveryDispensed = false;
let quoteAttempt = null;

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
	return value?.products?.catch?.plans instanceof Array && value?.products?.whisper?.plans instanceof Array && value?.products?.pulse?.plans instanceof Array;
}

document.querySelectorAll("[data-buy]").forEach((button) => button.addEventListener("click", () => {
	if (!(button instanceof HTMLButtonElement) || catalog === null) return;
	product = button.dataset.buy === "whisper" ? "whisper" : button.dataset.buy === "pulse" ? "pulse" : "catch";
	selectedPlanId = isPlanId(button.dataset.plan) ? button.dataset.plan : "standard";
	openCheckout();
}));

function openCheckout() {
	checkoutSession += 1;
	const productData = catalog.products[product];
	title.textContent = `Dispense ${product.toUpperCase()}`;
	intro.textContent = product === "catch" ? "Choose by lifetime, request quota, and storage. Every CATCH stays inbound-only."
		: product === "whisper" ? "Choose how long the encrypted message should wait and how many successful reads it allows. Encryption happens in this browser."
			: "Choose a lifetime heartbeat quota. Spend it quickly or distribute it across the full period.";
	noteField.hidden = product !== "whisper";
	note.required = product === "whisper";
	scheduleField.hidden = product !== "whisper";
	revealAtInput.value = "";
	burnAfterRead.checked = false;
	updateBurnChoice();
	output.hidden = true;
	output.value = "";
	deliveryActions.hidden = true;
	currentPortalUrl = "";
	portalLink.href = "#";
	copyPortalButton.textContent = "Copy portal link";
	paymentPanel.hidden = true;
	currentInvoice = "";
	deliveryDispensed = false;
	quoteAttempt = null;
	setPaymentStage("review");
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
		input.addEventListener("change", () => { selectedPlanId = plan.planId; updateBurnChoice(); updateSummary(); });
		const copy = document.createElement("span");
		copy.innerHTML = `<b>${plan.planId.toUpperCase()}</b><strong>${formatSats(plan.priceSats)} <small>SATS</small></strong><small>${plan.durationLabel} · ${plan.bestFor}</small>`;
		label.append(input, copy);
		return label;
	}));
}

function updateSummary() {
	const plan = selectedPlan();
	if (plan === null) return;
	const details = product === "catch" ? `${formatNumber(plan.requestLimit)} requests · ${formatBytes(plan.storageLimitBytes)} total storage · ${formatBytes(plan.maxBytesPerRequest)} per request`
		: product === "whisper" ? `${burnAfterRead.checked ? "Burn after the first successful read" : `${formatNumber(plan.readLimit)} successful ${plan.readLimit === 1 ? "read" : "reads"}`} · ${scheduledRevealIntent() === "immediate" ? "available immediately" : `reveals ${formatLocalDate(new Date(scheduledRevealIntent()))}`} · ${formatBytes(plan.maxCiphertextBytes)} encrypted payload`
			: `${formatNumber(plan.heartbeatLimit)} heartbeats for the whole lifetime · ${formatCadence(plan.suggestedCadenceSeconds)} when evenly distributed`;
	summary.innerHTML = `<div><span>${product.toUpperCase()} / ${plan.planId.toUpperCase()}</span><strong>${formatSats(plan.priceSats)} sats</strong></div><p>${plan.durationLabel}. ${details}.</p>`;
}

function updateBurnChoice() {
	const plan = selectedPlan();
	burnField.hidden = product !== "whisper" || plan === null || plan.readLimit === 1;
	if (burnField.hidden) burnAfterRead.checked = false;
}

function effectiveWhisperReadLimit() {
	const plan = selectedPlan();
	return burnAfterRead.checked ? 1 : plan?.readLimit ?? 1;
}

function scheduledRevealIntent() {
	if (revealAtInput.value.length === 0) return "immediate";
	const revealAt = new Date(revealAtInput.value);
	return Number.isNaN(revealAt.getTime()) ? "invalid" : revealAt.toISOString();
}

burnAfterRead.addEventListener("change", updateSummary);
revealAtInput.addEventListener("change", updateSummary);

closeButton.addEventListener("click", () => closeCheckout());
dialog.addEventListener("cancel", (event) => { event.preventDefault(); });
copyButton.addEventListener("click", async () => {
	if (currentInvoice.length === 0) return;
	try {
		await navigator.clipboard.writeText(currentInvoice);
		copyButton.textContent = "Invoice copied";
	} catch {
		invoice.focus();
		invoice.select();
		status.textContent = "Copy the selected BOLT11 invoice manually.";
	}
});
copyPortalButton.addEventListener("click", async () => {
	if (currentPortalUrl.length === 0) return;
	try {
		await navigator.clipboard.writeText(currentPortalUrl);
		copyPortalButton.textContent = "Portal link copied";
	} catch {
		status.textContent = "Could not copy the portal link. Open it and bookmark the page instead.";
	}
});
webLnButton.addEventListener("click", async () => {
	if (currentInvoice.length === 0) return;
	webLnButton.disabled = true;
	try {
		status.textContent = "Approve the payment in your browser wallet…";
		const provider = await requestProvider();
		await provider.sendPayment(currentInvoice);
		status.textContent = "Payment sent. Waiting for server confirmation…";
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Browser wallet payment was cancelled.";
	} finally {
		webLnButton.disabled = false;
	}
});

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const plan = selectedPlan();
	if (plan === null) return;
	const session = checkoutSession;
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
			const revealIntent = scheduledRevealIntent();
			if (revealIntent === "invalid") throw new Error("Choose a valid reveal date or leave it blank for immediate delivery.");
			const intent = `whisper:${selectedPlanId}:${effectiveWhisperReadLimit()}:${scheduledRevealIntent()}:${note.value}`;
			if (quoteAttempt?.intent !== intent) {
				const sealed = await sealWhisper(note.value);
				quoteAttempt = { intent, idempotencyKey: crypto.randomUUID(), ciphertext: sealed.ciphertext, encryptionKey: sealed.key };
			}
			encryptionKey = quoteAttempt.encryptionKey;
			const headers = { "content-type": "application/octet-stream", "idempotency-key": quoteAttempt.idempotencyKey, "x-whisper-plan": selectedPlanId, "x-whisper-read-limit": String(effectiveWhisperReadLimit()) };
			if (revealIntent !== "immediate") headers["x-whisper-reveal-at"] = revealIntent;
			response = await fetch("/api/payments/whisper", { method: "POST", headers, body: quoteAttempt.ciphertext });
		} else if (product === "catch") {
			const intent = `catch:${selectedPlanId}`;
			if (quoteAttempt?.intent !== intent) quoteAttempt = { intent, idempotencyKey: crypto.randomUUID() };
			response = await fetch("/api/payments/catch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": quoteAttempt.idempotencyKey }, body: JSON.stringify({ planId: selectedPlanId }) });
		} else {
			const intent = `pulse:${selectedPlanId}`;
			if (quoteAttempt?.intent !== intent) quoteAttempt = { intent, idempotencyKey: crypto.randomUUID() };
			response = await fetch("/api/payments/pulse", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": quoteAttempt.idempotencyKey }, body: JSON.stringify({ planId: selectedPlanId }) });
		}
		const quote = await response.json();
		if (response.status !== 402 || typeof quote.orderId !== "string" || typeof quote.bolt11 !== "string" || quote.amountSats !== plan.priceSats) throw new Error("The payment slot is unavailable.");
		if (session !== checkoutSession || !dialog.open) return;
		showInvoice(quote);
		await pollDelivery(quote.orderId, session);
	} catch (error) {
		if (session !== checkoutSession || !dialog.open) return;
		status.textContent = error instanceof Error ? error.message : "Checkout failed.";
	} finally {
		if (session === checkoutSession) submitButton.disabled = false;
	}
});

function selectedPlan() {
	if (catalog === null) return null;
	return catalog.products[product].plans.find((plan) => plan.planId === selectedPlanId && plan.available === true) ?? null;
}

async function pollDelivery(orderId, session) {
	for (let attempt = 0; attempt < 205; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		if (session !== checkoutSession || !dialog.open) return;
		const response = await fetch(`/api/payments/${encodeURIComponent(orderId)}`, { cache: "no-store" });
		if (response.status === 402) continue;
		if (!response.ok) throw new Error("Could not verify payment.");
		const result = await response.json();
		if (!result.settled || !result.resource) continue;
		const resource = result.resource;
		setPaymentStage("paid");
		paymentPanel.hidden = true;
		if (resource.product === "whisper") {
			output.value = whisperLink(location.origin, resource.publicId, resource.readToken, encryptionKey);
		} else if (resource.product === "catch") {
			const portalUrl = catchPortalLink(location.origin, resource.publicId, resource.ownerToken, resource.ingestToken);
			currentPortalUrl = portalUrl;
			portalLink.href = portalUrl;
			portalLink.textContent = "Open CATCH portal";
			portalNote.textContent = "Bookmark this private CATCH owner link. It cannot be recovered later.";
			deliveryActions.hidden = false;
			output.value = JSON.stringify({ portalUrl: portalUrl, ingestUrl: `${location.origin}/c/${resource.publicId}`, ingestToken: resource.ingestToken, ownerToken: resource.ownerToken, eventsUrl: `${location.origin}/api/catch/${resource.publicId}/events`, expiresAt: resource.expiresAt }, null, 2);
		} else {
			const portalUrl = pulsePortalLink(location.origin, resource.publicId, resource.ownerToken, resource.pingToken);
			currentPortalUrl = portalUrl;
			portalLink.href = portalUrl;
			portalLink.textContent = "Open PULSE dashboard";
			portalNote.textContent = "Bookmark this private PULSE owner link. Enable and copy the public status page from the dashboard if needed.";
			deliveryActions.hidden = false;
			output.value = JSON.stringify({ portalUrl, heartbeatUrl: `${location.origin}/p/${resource.publicId}`, ownerToken: resource.ownerToken, pingToken: resource.pingToken, expiresAt: resource.expiresAt }, null, 2);
		}
		output.hidden = false;
		deliveryDispensed = true;
		status.textContent = resource.product === "catch" ? "Dispensed. Open or save the private portal link now; no account can recover it for you." : "Dispensed. Copy this now; no account can recover it for you.";
		return;
	}
	if (session === checkoutSession && dialog.open) throw new Error("Invoice still unpaid or expired.");
}

function showInvoice(quote) {
	currentInvoice = quote.bolt11;
	invoice.value = quote.bolt11;
	const qrMarkup = renderQr(quote.bolt11);
	qr.innerHTML = qrMarkup;
	const qrImage = new Image();
	const qrUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrMarkup)}`;
	qrImage.alt = "Lightning invoice QR code";
	qrImage.src = qrUrl;
	qr.replaceChildren(qrImage);
	amount.textContent = `${formatSats(quote.amountSats)} sats`;
	walletLink.href = `lightning:${quote.bolt11}`;
	webLnButton.hidden = !("webln" in window);
	paymentPanel.hidden = false;
	submitButton.hidden = true;
	setPaymentStage("pending");
	status.textContent = "Waiting for payment. This screen updates automatically after settlement.";
	dialog.scrollTo({ top: 0, behavior: "smooth" });
}

function setPaymentStage(stage) {
	progress.dataset.stage = stage;
	form.dataset.stage = stage;
	if (stage === "review") submitButton.hidden = false;
}

function closeCheckout() {
	if (deliveryDispensed && !window.confirm("Close this delivery? Once closed, this private link and its credentials cannot be recovered.")) return;
	checkoutSession += 1;
	dialog.close();
}

function isPlanId(value) { return value === "spark" || value === "standard" || value === "long"; }
function catchPortalLink(origin, publicId, ownerToken, ingestToken) {
	const payload = new TextEncoder().encode(JSON.stringify({ publicId, ownerToken, ingestToken }));
	let binary = "";
	for (const byte of payload) binary += String.fromCharCode(byte);
	return `${origin}/catch.html#${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}
function pulsePortalLink(origin, publicId, ownerToken, pingToken) {
	const payload = new TextEncoder().encode(JSON.stringify({ publicId, ownerToken, pingToken }));
	let binary = "";
	for (const byte of payload) binary += String.fromCharCode(byte);
	return `${origin}/pulse.html#${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}
function formatSats(value) { return new Intl.NumberFormat("en-US").format(value); }
function formatNumber(value) { return new Intl.NumberFormat("en-US").format(value); }
function formatBytes(value) { return value >= 1024 * 1024 ? `${Number((value / (1024 * 1024)).toFixed(2))} MiB` : `${value / 1024} KiB`; }
function formatCadence(seconds) { return seconds === 60 ? "about every minute" : seconds < 60 ? `about every ${seconds} seconds` : `about every ${seconds / 60} minutes`; }
function formatLocalDate(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value); }
