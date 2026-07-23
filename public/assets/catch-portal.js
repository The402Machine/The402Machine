const connection = document.querySelector("#portal-connection");
const content = document.querySelector("#portal-content");
const errorPanel = document.querySelector("#portal-error");
const errorCopy = document.querySelector("#portal-error-copy");
const importValue = document.querySelector("#portal-import");
const importButton = document.querySelector("#portal-import-submit");
const copyLinkButton = document.querySelector("#portal-copy-link");
const linkCard = document.querySelector("#portal-link-card");
const title = document.querySelector("#portal-title");
const statusBadge = document.querySelector("#portal-status");
const remaining = document.querySelector("#portal-remaining");
const expiry = document.querySelector("#portal-expiry");
const requests = document.querySelector("#portal-requests");
const requestsDetail = document.querySelector("#portal-requests-detail");
const requestsMeter = document.querySelector("#portal-requests-meter");
const storage = document.querySelector("#portal-storage");
const storageDetail = document.querySelector("#portal-storage-detail");
const storageMeter = document.querySelector("#portal-storage-meter");
const payload = document.querySelector("#portal-payload");
const ingestUrl = document.querySelector("#portal-ingest-url");
const authPreview = document.querySelector("#portal-auth-preview");
const copyEndpointButton = document.querySelector("#portal-copy-endpoint");
const copyAuthButton = document.querySelector("#portal-copy-auth");
const copyCurlButton = document.querySelector("#portal-copy-curl");
const refreshButton = document.querySelector("#portal-refresh");
const eventsStatus = document.querySelector("#portal-events-status");
const eventsContainer = document.querySelector("#portal-events");
const destroyButton = document.querySelector("#portal-destroy");

if (!(connection instanceof HTMLElement) || !(content instanceof HTMLElement) || !(errorPanel instanceof HTMLElement) || !(errorCopy instanceof HTMLElement) || !(importValue instanceof HTMLTextAreaElement) || !(importButton instanceof HTMLButtonElement) || !(copyLinkButton instanceof HTMLButtonElement) || !(linkCard instanceof HTMLElement) || !(title instanceof HTMLElement) || !(statusBadge instanceof HTMLElement) || !(remaining instanceof HTMLElement) || !(expiry instanceof HTMLElement) || !(requests instanceof HTMLElement) || !(requestsDetail instanceof HTMLElement) || !(requestsMeter instanceof HTMLElement) || !(storage instanceof HTMLElement) || !(storageDetail instanceof HTMLElement) || !(storageMeter instanceof HTMLElement) || !(payload instanceof HTMLElement) || !(ingestUrl instanceof HTMLInputElement) || !(authPreview instanceof HTMLElement) || !(copyEndpointButton instanceof HTMLButtonElement) || !(copyAuthButton instanceof HTMLButtonElement) || !(copyCurlButton instanceof HTMLButtonElement) || !(refreshButton instanceof HTMLButtonElement) || !(eventsStatus instanceof HTMLElement) || !(eventsContainer instanceof HTMLElement) || !(destroyButton instanceof HTMLButtonElement)) throw new Error("CATCH portal is incomplete");

const capability = parseCapability(location.hash.slice(1));
let resource = null;
let countdownTimer = 0;

if (capability === null) {
	showError("This portal link is incomplete. Use the exact URL dispensed after payment.");
} else {
	linkCard.hidden = false;
	bindActions();
	void loadPortal();
}

importButton.addEventListener("click", () => {
	try {
		const delivery = JSON.parse(importValue.value);
		const imported = validateCapability({ publicId: delivery.publicId ?? publicIdFromUrl(delivery.ingestUrl), ownerToken: delivery.ownerToken, ingestToken: delivery.ingestToken });
		if (imported === null) throw new Error("invalid capability");
		history.replaceState(null, "", `${location.pathname}#${encodeCapability(imported)}`);
		location.reload();
	} catch {
		errorCopy.textContent = "That JSON does not contain a valid CATCH owner and ingest capability.";
		importValue.focus();
	}
});

function bindActions() {
	copyLinkButton.addEventListener("click", () => copyWithFeedback(copyLinkButton, location.href, "Portal link copied"));
	copyEndpointButton.addEventListener("click", () => copyWithFeedback(copyEndpointButton, endpointUrl(), "Endpoint copied"));
	copyAuthButton.addEventListener("click", () => copyWithFeedback(copyAuthButton, `Authorization: Bearer ${capability.ingestToken}`, "Auth header copied"));
	copyCurlButton.addEventListener("click", () => copyWithFeedback(copyCurlButton, curlExample(), "cURL copied"));
	refreshButton.addEventListener("click", () => loadEvents());
	destroyButton.addEventListener("click", () => destroyCatch());
}

async function loadPortal() {
	try {
		const [statusResponse, eventsResponse] = await Promise.all([ownerFetch(apiUrl()), ownerFetch(`${apiUrl()}/events?limit=50`)]);
		if (!statusResponse.ok || !eventsResponse.ok) throw new Error(responseMessage(statusResponse));
		resource = await statusResponse.json();
		const eventResult = await eventsResponse.json();
		renderResource(resource);
		renderEvents(eventResult.events instanceof Array ? eventResult.events : []);
		content.hidden = false;
		errorPanel.hidden = true;
		connection.textContent = "CONNECTED";
		connection.classList.add("online");
	} catch (error) {
		showError(error instanceof Error ? error.message : "The CATCH portal could not be loaded.");
	}
}

async function loadEvents() {
	if (capability === null) return;
	refreshButton.disabled = true;
	eventsStatus.textContent = "Refreshing events…";
	try {
		const response = await ownerFetch(`${apiUrl()}/events?limit=50`);
		if (!response.ok) throw new Error(responseMessage(response));
		const result = await response.json();
		renderEvents(result.events instanceof Array ? result.events : []);
		await refreshResource();
	} catch (error) {
		eventsStatus.textContent = error instanceof Error ? error.message : "Could not refresh events.";
	} finally {
		refreshButton.disabled = false;
	}
}

async function refreshResource() {
	const response = await ownerFetch(apiUrl());
	if (!response.ok) throw new Error(responseMessage(response));
	resource = await response.json();
	renderResource(resource);
}

function renderResource(value) {
	title.textContent = `${String(value.planId ?? "catch").toUpperCase()} CATCH`;
	statusBadge.textContent = String(value.status ?? "unknown").toUpperCase();
	statusBadge.dataset.status = String(value.status ?? "unknown");
	const accepted = safeNumber(value.acceptedRequestCount);
	const requestLimit = safeNumber(value.requestLimit);
	const stored = safeNumber(value.storedBytes);
	const storageLimit = safeNumber(value.storageLimitBytes);
	requests.textContent = `${formatNumber(accepted)} / ${formatNumber(requestLimit)}`;
	requestsDetail.textContent = `${formatNumber(Math.max(0, requestLimit - accepted))} requests remaining`;
	requestsMeter.style.width = `${percentage(accepted, requestLimit)}%`;
	storage.textContent = `${formatBytes(stored)} / ${formatBytes(storageLimit)}`;
	storageDetail.textContent = `${formatBytes(Math.max(0, storageLimit - stored))} remaining`;
	storageMeter.style.width = `${percentage(stored, storageLimit)}%`;
	payload.textContent = formatBytes(safeNumber(value.maxBytesPerRequest));
	ingestUrl.value = endpointUrl();
	authPreview.textContent = `Authorization: Bearer ${maskedToken(capability.ingestToken)}`;
	expiry.textContent = `Expires ${formatDate(value.expiresAt)}`;
	window.clearInterval(countdownTimer);
	updateCountdown();
	countdownTimer = window.setInterval(updateCountdown, 1000);
}

function renderEvents(events) {
	eventsContainer.replaceChildren();
	if (events.length === 0) {
		const empty = document.createElement("div");
		empty.className = "portal-empty";
		const heading = document.createElement("strong");
		heading.textContent = "No events yet.";
		const copy = document.createElement("span");
		copy.textContent = "POST to the ingest endpoint and refresh this portal.";
		empty.append(heading, copy);
		eventsContainer.append(empty);
		eventsStatus.textContent = "Listening for inbound events.";
		return;
	}
	for (const event of events) eventsContainer.append(eventCard(event));
	eventsStatus.textContent = `${events.length} most recent event${events.length === 1 ? "" : "s"}. Newest first.`;
}

function eventCard(event) {
	const article = document.createElement("article");
	article.className = "portal-event";
	const head = document.createElement("div");
	head.className = "portal-event-head";
	const identity = document.createElement("div");
	const sequence = document.createElement("strong");
	sequence.textContent = `#${formatNumber(safeNumber(event.sequenceNumber))}`;
	const type = document.createElement("span");
	type.textContent = String(event.contentType ?? "unknown");
	identity.append(sequence, type);
	const received = document.createElement("time");
	received.dateTime = String(event.receivedAt ?? "");
	received.textContent = formatDate(event.receivedAt);
	head.append(identity, received);

	const body = document.createElement("pre");
	body.textContent = eventBody(event);
	const details = document.createElement("details");
	const summary = document.createElement("summary");
	summary.textContent = "Headers";
	const headers = document.createElement("pre");
	headers.textContent = JSON.stringify(event.headers ?? {}, null, 2);
	details.append(summary, headers);

	const actions = document.createElement("div");
	actions.className = "portal-event-actions";
	const copyButton = document.createElement("button");
	copyButton.className = "button ghost";
	copyButton.type = "button";
	copyButton.textContent = "Copy body";
	copyButton.addEventListener("click", () => copyWithFeedback(copyButton, body.textContent ?? "", "Body copied"));
	const deleteButton = document.createElement("button");
	deleteButton.className = "button danger ghost";
	deleteButton.type = "button";
	deleteButton.textContent = "Delete event";
	deleteButton.addEventListener("click", () => deleteEvent(String(event.id ?? ""), deleteButton));
	actions.append(copyButton, deleteButton);
	article.append(head, body, details, actions);
	return article;
}

async function deleteEvent(eventId, button) {
	if (eventId.length === 0 || !window.confirm("Delete this event permanently?")) return;
	button.disabled = true;
	try {
		const response = await ownerFetch(`${apiUrl()}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
		if (!response.ok) throw new Error(responseMessage(response));
		await loadEvents();
	} catch (error) {
		eventsStatus.textContent = error instanceof Error ? error.message : "Could not delete the event.";
		button.disabled = false;
	}
}

async function destroyCatch() {
	if (!window.confirm("Destroy this CATCH, every stored event, and both access capabilities permanently?")) return;
	destroyButton.disabled = true;
	try {
		const response = await ownerFetch(apiUrl(), { method: "DELETE" });
		if (!response.ok) throw new Error(responseMessage(response));
		window.clearInterval(countdownTimer);
		content.hidden = true;
		showError("This CATCH has been destroyed. Its portal and ingest capability no longer work.");
	} catch (error) {
		destroyButton.disabled = false;
		showError(error instanceof Error ? error.message : "Could not destroy this CATCH.");
	}
}

function ownerFetch(url, options = {}) {
	return fetch(url, { ...options, cache: "no-store", headers: { ...(options.headers ?? {}), authorization: `Bearer ${capability.ownerToken}` } });
}

function apiUrl() {
	return `/api/catch/${encodeURIComponent(capability.publicId)}`;
}

function endpointUrl() {
	return `${location.origin}/c/${encodeURIComponent(capability.publicId)}`;
}

function curlExample() {
	return `curl --request POST --url ${shellQuote(endpointUrl())} --header ${shellQuote(`Authorization: Bearer ${capability.ingestToken}`)} --header ${shellQuote("Content-Type: application/json")} --data ${shellQuote('{"event":"example"}')}`;
}

function updateCountdown() {
	if (resource === null) return;
	const remainingMs = new Date(resource.expiresAt).getTime() - Date.now();
	remaining.textContent = remainingMs <= 0 ? "FUSE ENDED" : formatDuration(remainingMs);
	if (remainingMs <= 0) {
		statusBadge.textContent = "EXPIRED";
		statusBadge.dataset.status = "expired";
		window.clearInterval(countdownTimer);
	}
}

function parseCapability(fragment) {
	try {
		const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(fragment)));
		return validateCapability(decoded);
	} catch {
		return null;
	}
}

function validateCapability(value) {
	if (typeof value !== "object" || value === null) return null;
	if (typeof value.publicId !== "string" || !/^catch_[A-Za-z0-9_-]+$/.test(value.publicId)) return null;
	if (typeof value.ownerToken !== "string" || !/^catch_own_[A-Za-z0-9_-]{43}$/.test(value.ownerToken)) return null;
	if (typeof value.ingestToken !== "string" || !/^catch_ing_[A-Za-z0-9_-]{43}$/.test(value.ingestToken)) return null;
	return { publicId: value.publicId, ownerToken: value.ownerToken, ingestToken: value.ingestToken };
}

function publicIdFromUrl(value) {
	try {
		const url = new URL(String(value));
		return url.origin === location.origin && url.pathname.startsWith("/c/") ? decodeURIComponent(url.pathname.slice(3)) : "";
	} catch {
		return "";
	}
}

function encodeCapability(value) {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = "=".repeat((4 - normalized.length % 4) % 4);
	const binary = atob(normalized + padding);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function eventBody(event) {
	let bytes;
	try {
		bytes = base64Decode(String(event.body ?? ""));
	} catch {
		return "[Invalid payload encoding]";
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (String(event.contentType ?? "").includes("json")) {
			try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
		}
		return text;
	} catch {
		return `[${formatBytes(bytes.byteLength)} binary payload · base64]\n${String(event.body ?? "")}`;
	}
}

function base64Decode(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function copyWithFeedback(button, value, successLabel) {
	const original = button.textContent;
	try {
		await navigator.clipboard.writeText(value);
		button.textContent = successLabel;
		window.setTimeout(() => { button.textContent = original; }, 1800);
	} catch {
		button.textContent = "Copy failed";
		window.setTimeout(() => { button.textContent = original; }, 1800);
	}
}

function showError(message) {
	connection.textContent = "OFFLINE";
	connection.classList.remove("online");
	errorCopy.textContent = message;
	errorPanel.hidden = false;
	content.hidden = true;
}

function responseMessage(response) {
	return response.status === 401 || response.status === 404 ? "This owner capability is invalid, expired, or already destroyed." : "The CATCH service is temporarily unavailable.";
}

function safeNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function percentage(value, limit) { return limit <= 0 ? 0 : Math.max(0, Math.min(100, value / limit * 100)); }
function formatNumber(value) { return new Intl.NumberFormat("en-US").format(value); }
function formatBytes(value) { return value >= 1024 * 1024 ? `${Number((value / (1024 * 1024)).toFixed(2))} MiB` : value >= 1024 ? `${Number((value / 1024).toFixed(1))} KiB` : `${value} B`; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function formatDuration(milliseconds) { const total = Math.max(0, Math.floor(milliseconds / 1000)); const days = Math.floor(total / 86400); const hours = Math.floor(total % 86400 / 3600); const minutes = Math.floor(total % 3600 / 60); const seconds = total % 60; return days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`; }
function maskedToken(token) { return `${token.slice(0, 10)}${"•".repeat(18)}`; }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
