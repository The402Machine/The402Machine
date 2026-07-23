import { sealWhisper, whisperLink } from "/assets/whisper.js";

const dialog = document.querySelector("#checkout");
const form = document.querySelector("#checkout-form");
const title = document.querySelector("#checkout-title");
const noteField = document.querySelector("#whisper-note-field");
const note = document.querySelector("#whisper-note");
const status = document.querySelector("#checkout-status");
const output = document.querySelector("#checkout-output");
const closeButton = document.querySelector("#checkout-close");

if (!(dialog instanceof HTMLDialogElement) || !(form instanceof HTMLFormElement) || !(title instanceof HTMLElement) || !(noteField instanceof HTMLElement) || !(note instanceof HTMLTextAreaElement) || !(status instanceof HTMLElement) || !(output instanceof HTMLTextAreaElement) || !(closeButton instanceof HTMLButtonElement)) throw new Error("Checkout is incomplete");

let product = "catch";
let encryptionKey = "";

void configureCheckout();

async function configureCheckout() {
	try {
		const response = await fetch("/api/catalog", { cache: "no-store" });
		const catalog = await response.json();
		if (!response.ok || catalog.checkoutEnabled !== true) disableCheckout();
	} catch {
		disableCheckout();
	}
}

function disableCheckout() {
	document.querySelectorAll("[data-buy]").forEach((button) => {
		if (button instanceof HTMLButtonElement) {
			button.disabled = true;
			button.textContent = "Checkout disabled";
		}
	});
}

document.querySelectorAll("[data-buy]").forEach((button) => button.addEventListener("click", () => {
	product = button.getAttribute("data-buy") === "whisper" ? "whisper" : "catch";
	title.textContent = `Dispense ${product.toUpperCase()}`;
	noteField.hidden = product !== "whisper";
	note.required = product === "whisper";
	status.textContent = "Choose a cartridge. Long remains sealed.";
	output.hidden = true;
	dialog.showModal();
}));

closeButton.addEventListener("click", () => dialog.close());

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const data = new FormData(form);
	const planId = data.get("planId") === "standard" ? "standard" : "spark";
	const idempotencyKey = crypto.randomUUID();
	let response;
	try {
		const catalogResponse = await fetch("/api/catalog", { cache: "no-store" });
		const catalog = await catalogResponse.json();
		if (!catalogResponse.ok || catalog.checkoutEnabled !== true) throw new Error("Public Lightning checkout is currently disabled.");
		status.textContent = "Requesting a Lightning invoice…";
		if (product === "whisper") {
			const sealed = await sealWhisper(note.value);
			encryptionKey = sealed.key;
			response = await fetch("/api/payments/whisper", { method: "POST", headers: { "content-type": "application/octet-stream", "idempotency-key": idempotencyKey, "x-whisper-plan": planId }, body: sealed.ciphertext });
		} else {
			response = await fetch("/api/payments/catch", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ planId }) });
		}
		const quote = await response.json();
		if (response.status !== 402 || typeof quote.orderId !== "string" || typeof quote.bolt11 !== "string") throw new Error("The payment slot is unavailable.");
		output.value = quote.bolt11;
		output.hidden = false;
		status.textContent = `${quote.amountSats} sats. Pay the invoice; this page will check automatically.`;
		await pollDelivery(quote.orderId);
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Checkout failed.";
	}
});

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