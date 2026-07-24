const selectors = {
	connection: "#portal-connection", content: "#portal-content", errorPanel: "#portal-error", errorCopy: "#portal-error-copy", importValue: "#portal-import", importButton: "#portal-import-submit", copyLinkButton: "#portal-copy-link", linkCard: "#portal-link-card", title: "#portal-title", statusBadge: "#portal-status", remaining: "#portal-remaining", expiry: "#portal-expiry", requests: "#portal-requests", requestsDetail: "#portal-requests-detail", requestsMeter: "#portal-requests-meter", storage: "#portal-storage", storageDetail: "#portal-storage-detail", storageMeter: "#portal-storage-meter", payload: "#portal-payload", ingestUrl: "#portal-ingest-url", authPreview: "#portal-auth-preview", copyEndpointButton: "#portal-copy-endpoint", copyAuthButton: "#portal-copy-auth", copyCurlButton: "#portal-copy-curl", refreshButton: "#portal-refresh", eventsStatus: "#portal-events-status", eventsContainer: "#portal-events", accessFilter: "#portal-event-access", methodFilter: "#portal-event-method", contentTypeFilter: "#portal-event-content-type", searchFilter: "#portal-event-search", pageSize: "#portal-event-page-size", previousButton: "#portal-events-prev", nextButton: "#portal-events-next", pageLabel: "#portal-events-page", destroyButton: "#portal-destroy",
};
const elements = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, document.querySelector(selector)]));
if (Object.values(elements).some((element) => element === null)) throw new Error("CATCH portal is incomplete");

const { connection, content, errorPanel, errorCopy, importValue, importButton, copyLinkButton, linkCard, title, statusBadge, remaining, expiry, requests, requestsDetail, requestsMeter, storage, storageDetail, storageMeter, payload, ingestUrl, authPreview, copyEndpointButton, copyAuthButton, copyCurlButton, refreshButton, eventsStatus, eventsContainer, accessFilter, methodFilter, contentTypeFilter, searchFilter, pageSize, previousButton, nextButton, pageLabel, destroyButton } = elements;
const capability = parseCapability(location.hash.slice(1));
let resource = null;
let countdownTimer = 0;
let currentCursor = null;
let nextCursor = null;
let cursorHistory = [];
let currentPage = 1;
let searchTimer = 0;

if (capability === null) showError("This portal link is incomplete. Use the exact URL dispensed after payment.");
else {
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
	refreshButton.addEventListener("click", resetAndLoadEvents);
	for (const filter of [accessFilter, methodFilter, contentTypeFilter, pageSize]) filter.addEventListener("change", resetAndLoadEvents);
	searchFilter.addEventListener("input", () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(resetAndLoadEvents, 300); });
	previousButton.addEventListener("click", () => {
		const previous = cursorHistory.pop();
		if (previous === undefined) return;
		currentCursor = previous;
		currentPage = Math.max(1, currentPage - 1);
		void loadEvents();
	});
	nextButton.addEventListener("click", () => {
		if (nextCursor === null) return;
		cursorHistory.push(currentCursor);
		currentCursor = nextCursor;
		currentPage += 1;
		void loadEvents();
	});
	destroyButton.addEventListener("click", () => destroyCatch());
}

async function loadPortal() {
	try {
		const response = await ownerFetch(apiUrl());
		if (!response.ok) throw new Error(responseMessage(response));
		resource = await response.json();
		renderResource(resource);
		content.hidden = false;
		errorPanel.hidden = true;
		connection.textContent = "CONNECTED";
		connection.classList.add("online");
		await loadEvents();
	} catch (error) { showError(error instanceof Error ? error.message : "The CATCH portal could not be loaded."); }
}

async function loadEvents() {
	if (capability === null) return;
	refreshButton.disabled = true;
	eventsStatus.textContent = "Loading events…";
	try {
		const response = await ownerFetch(eventsApiUrl());
		if (!response.ok) throw new Error(responseMessage(response));
		const result = await response.json();
		renderEvents(Array.isArray(result.events) ? result.events : []);
		nextCursor = Number.isInteger(result.nextCursor) ? result.nextCursor : null;
		pageLabel.textContent = `Page ${currentPage}`;
		previousButton.disabled = cursorHistory.length === 0;
		nextButton.disabled = nextCursor === null;
		await refreshResource();
	} catch (error) { eventsStatus.textContent = error instanceof Error ? error.message : "Could not refresh events."; }
	finally { refreshButton.disabled = false; }
}

function resetAndLoadEvents() {
	currentCursor = null;
	nextCursor = null;
	cursorHistory = [];
	currentPage = 1;
	void loadEvents();
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
	const accepted = safeNumber(value.acceptedRequestCount), requestLimit = safeNumber(value.requestLimit), stored = safeNumber(value.storedBytes), storageLimit = safeNumber(value.storageLimitBytes);
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
		const empty = document.createElement("div"); empty.className = "portal-empty";
		const heading = document.createElement("strong"); heading.textContent = "No matching events.";
		const copy = document.createElement("span"); copy.textContent = "Send a request or adjust the filters.";
		empty.append(heading, copy); eventsContainer.append(empty); eventsStatus.textContent = "No events on this page."; return;
	}
	for (const event of events) eventsContainer.append(eventCard(event));
	eventsStatus.textContent = `${events.length} event${events.length === 1 ? "" : "s"} on this page. Newest first.`;
}

function eventCard(event) {
	const article = document.createElement("article"); article.className = "portal-event";
	const head = document.createElement("div"); head.className = "portal-event-head";
	const identity = document.createElement("div");
	const sequence = document.createElement("strong"); sequence.textContent = `#${formatNumber(safeNumber(event.sequenceNumber))}`;
	const method = document.createElement("b"); method.className = "portal-event-method"; method.textContent = String(event.method ?? "POST");
	const access = document.createElement("b"); access.className = `portal-event-access ${event.authenticated === true ? "authenticated" : "public"}`; access.textContent = event.authenticated === true ? "AUTHENTICATED" : "PUBLIC";
	const type = document.createElement("span"); type.textContent = String(event.contentType ?? "unknown");
	const location = document.createElement("span"); location.className = "portal-event-location"; location.textContent = compactLocation(event.ipLocation);
	identity.append(sequence, method, access, type, location);
	const received = document.createElement("time"); received.dateTime = String(event.receivedAt ?? ""); received.textContent = formatDate(event.receivedAt); head.append(identity, received);
	const body = document.createElement("pre"); body.textContent = eventBody(event);
	const details = document.createElement("details"), summary = document.createElement("summary"), headers = document.createElement("pre"); summary.textContent = "Headers"; headers.textContent = JSON.stringify(event.headers ?? {}, null, 2); details.append(summary, headers);
	const ipDetails = document.createElement("details"), ipSummary = document.createElement("summary"), ipInfo = document.createElement("pre"); ipSummary.textContent = "IP Location Info"; ipInfo.textContent = JSON.stringify({ ip: event.sourceIp ?? null, ...(validLocation(event.ipLocation) ? event.ipLocation : {}) }, null, 2); ipDetails.append(ipSummary, ipInfo);
	const actions = document.createElement("div"); actions.className = "portal-event-actions";
	const copyButton = document.createElement("button"); copyButton.className = "button ghost"; copyButton.type = "button"; copyButton.textContent = "Copy body"; copyButton.addEventListener("click", () => copyWithFeedback(copyButton, body.textContent ?? "", "Body copied"));
	const deleteButton = document.createElement("button"); deleteButton.className = "button danger ghost"; deleteButton.type = "button"; deleteButton.textContent = "Delete event"; deleteButton.addEventListener("click", () => deleteEvent(String(event.id ?? ""), deleteButton));
	actions.append(copyButton, deleteButton); article.append(head, body, details, ipDetails, actions); return article;
}

async function deleteEvent(eventId, button) {
	if (eventId.length === 0 || !window.confirm("Delete this event permanently?")) return;
	button.disabled = true;
	try { const response = await ownerFetch(`${apiUrl()}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }); if (!response.ok) throw new Error(responseMessage(response)); await loadEvents(); }
	catch (error) { eventsStatus.textContent = error instanceof Error ? error.message : "Could not delete the event."; button.disabled = false; }
}

async function destroyCatch() {
	if (!window.confirm("Destroy this CATCH, every stored event, and both access capabilities permanently?")) return;
	destroyButton.disabled = true;
	try { const response = await ownerFetch(apiUrl(), { method: "DELETE" }); if (!response.ok) throw new Error(responseMessage(response)); window.clearInterval(countdownTimer); content.hidden = true; showError("This CATCH has been destroyed. Its portal and ingest capability no longer work."); }
	catch (error) { destroyButton.disabled = false; showError(error instanceof Error ? error.message : "Could not destroy this CATCH."); }
}

function ownerFetch(url, options = {}) { return fetch(url, { ...options, cache: "no-store", headers: { ...(options.headers ?? {}), authorization: `Bearer ${capability.ownerToken}` } }); }
function apiUrl() { return `/api/catch/${encodeURIComponent(capability.publicId)}`; }
function endpointUrl() { return `${location.origin}/c/${encodeURIComponent(capability.publicId)}`; }
function eventsApiUrl() {
	const parameters = new URLSearchParams({ limit: pageSize.value });
	if (currentCursor !== null) parameters.set("cursor", String(currentCursor));
	if (accessFilter.value) parameters.set("access", accessFilter.value);
	if (methodFilter.value) parameters.set("method", methodFilter.value);
	if (contentTypeFilter.value) parameters.set("contentType", contentTypeFilter.value);
	if (searchFilter.value.trim()) parameters.set("q", searchFilter.value.trim());
	return `${apiUrl()}/events?${parameters.toString()}`;
}
function curlExample() { return `curl --request POST --url ${shellQuote(endpointUrl())} --header ${shellQuote(`Authorization: Bearer ${capability.ingestToken}`)} --header ${shellQuote("Content-Type: application/json")} --data ${shellQuote('{"event":"canary"}')}`; }
function updateCountdown() { if (resource === null) return; const remainingMs = new Date(resource.expiresAt).getTime() - Date.now(); remaining.textContent = remainingMs <= 0 ? "FUSE ENDED" : formatDuration(remainingMs); if (remainingMs <= 0) { statusBadge.textContent = "EXPIRED"; statusBadge.dataset.status = "expired"; window.clearInterval(countdownTimer); } }
function parseCapability(fragment) { try { return validateCapability(JSON.parse(new TextDecoder().decode(base64UrlDecode(fragment)))); } catch { return null; } }
function validateCapability(value) { if (typeof value !== "object" || value === null || typeof value.publicId !== "string" || !/^catch_[A-Za-z0-9_-]+$/.test(value.publicId) || typeof value.ownerToken !== "string" || !/^catch_own_[A-Za-z0-9_-]{43}$/.test(value.ownerToken) || typeof value.ingestToken !== "string" || !/^catch_ing_[A-Za-z0-9_-]{43}$/.test(value.ingestToken)) return null; return { publicId: value.publicId, ownerToken: value.ownerToken, ingestToken: value.ingestToken }; }
function publicIdFromUrl(value) { try { const url = new URL(String(value)); return url.origin === location.origin && url.pathname.startsWith("/c/") ? decodeURIComponent(url.pathname.slice(3)) : ""; } catch { return ""; } }
function encodeCapability(value) { const bytes = new TextEncoder().encode(JSON.stringify(value)); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function base64UrlDecode(value) { const normalized = value.replaceAll("-", "+").replaceAll("_", "/"); const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function eventBody(event) { let bytes; try { bytes = base64Decode(String(event.body ?? "")); } catch { return "[Invalid payload encoding]"; } try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (String(event.contentType ?? "").includes("json")) { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } } return text; } catch { return `[${formatBytes(bytes.byteLength)} binary payload · base64]\n${String(event.body ?? "")}`; } }
function base64Decode(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
async function copyWithFeedback(button, value, successLabel) { const original = button.textContent; try { await navigator.clipboard.writeText(value); button.textContent = successLabel; } catch { button.textContent = "Copy failed"; } window.setTimeout(() => { button.textContent = original; }, 1800); }
function showError(message) { connection.textContent = "OFFLINE"; connection.classList.remove("online"); errorCopy.textContent = message; errorPanel.hidden = false; content.hidden = true; }
function responseMessage(response) { return response.status === 401 || response.status === 404 ? "This owner capability is invalid, expired, or already destroyed." : "The CATCH service is temporarily unavailable."; }
function safeNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function percentage(value, limit) { return limit <= 0 ? 0 : Math.max(0, Math.min(100, value / limit * 100)); }
function formatNumber(value) { return new Intl.NumberFormat("en-US").format(value); }
function formatBytes(value) { return value >= 1024 * 1024 ? `${Number((value / (1024 * 1024)).toFixed(2))} MiB` : value >= 1024 ? `${Number((value / 1024).toFixed(1))} KiB` : `${value} B`; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function formatDuration(milliseconds) { const total = Math.max(0, Math.floor(milliseconds / 1000)), days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60; return days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`; }
function maskedToken(token) { return `${token.slice(0, 10)}${"•".repeat(18)}`; }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function validLocation(value) { return typeof value === "object" && value !== null; }
function compactLocation(value) { if (!validLocation(value)) return "Location unavailable"; const city = typeof value.city === "string" && value.city.length > 0 ? value.city : "Unknown city"; return `${countryFlag(value.country)} ${city}`.trim(); }
function countryFlag(value) { if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) return "🌐"; return String.fromCodePoint(...value.toUpperCase().split("").map((letter) => 127397 + letter.charCodeAt(0))); }
