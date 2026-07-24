const dashboard = document.querySelector("#pulse-dashboard");
const errorPanel = document.querySelector("#pulse-error");
const connection = document.querySelector("#pulse-connection");
const ownerPanel = document.querySelector("#pulse-owner");
const stateBadge = document.querySelector("#pulse-state");
const name = document.querySelector("#pulse-name");
const description = document.querySelector("#pulse-description");
const last = document.querySelector("#pulse-last");
const lastRelative = document.querySelector("#pulse-last-relative");
const next = document.querySelector("#pulse-next");
const schedule = document.querySelector("#pulse-schedule");
const expiry = document.querySelector("#pulse-expiry");
const signalTrack = document.querySelector("#pulse-signal-track");
const historyCount = document.querySelector("#pulse-history-count");
const historyCopy = document.querySelector("#pulse-history-copy");
const heartbeatUrl = document.querySelector("#pulse-heartbeat-url");
const publicCard = document.querySelector("#pulse-public-card");
const publicUrl = document.querySelector("#pulse-public-url");
const copyUrl = document.querySelector("#pulse-copy-url");
const copyCurl = document.querySelector("#pulse-copy-curl");
const copyPublic = document.querySelector("#pulse-copy-public");
const openPublic = document.querySelector("#pulse-open-public");
const disablePublic = document.querySelector("#pulse-disable-public");
const publicStatus = document.querySelector("#pulse-public-status");
const settings = document.querySelector("#pulse-settings");
const nameInput = document.querySelector("#pulse-name-input");
const descriptionInput = document.querySelector("#pulse-description-input");
const intervalInput = document.querySelector("#pulse-interval-input");
const graceInput = document.querySelector("#pulse-grace-input");
const settingsStatus = document.querySelector("#pulse-settings-status");
const destroy = document.querySelector("#pulse-destroy");

const required = [dashboard, errorPanel, connection, ownerPanel, stateBadge, name, description, last, lastRelative, next, schedule, expiry, signalTrack, historyCount, historyCopy, heartbeatUrl, publicCard, publicUrl, copyUrl, copyCurl, copyPublic, openPublic, disablePublic, publicStatus, settings, nameInput, descriptionInput, intervalInput, graceInput, settingsStatus, destroy];
if (required.some((element) => element === null)) throw new Error("PULSE owner dashboard is incomplete");

const legacyPublicId = parseLegacyPublicId();
const capability = legacyPublicId === null ? parseCapability() : null;
let current = null;
let heartbeatEndpoint = "";
let publicEndpoint = "";
let previousHeartbeatCount = null;
let refreshing = false;

if (legacyPublicId !== null) location.replace(`/pulse-public.html#${encodeURIComponent(legacyPublicId)}`);
else if (capability === null) showError();
else {
	void refresh();
	setInterval(() => void refresh(), 3_000);
	setInterval(updateClockLabels, 1_000);
}

async function refresh() {
	if (refreshing || capability === null) return;
	refreshing = true;
	try {
		const response = await fetch(`/api/pulse/${encodeURIComponent(capability.publicId)}`, { cache: "no-store", headers: { authorization: `Bearer ${capability.ownerToken}` } });
		if (!response.ok) return showError();
		const received = await response.json();
		appendHeartbeatObservation(received);
		current = received;
		render(received);
	} catch {
		connection.textContent = "RECONNECTING";
		connection.classList.remove("online");
	} finally {
		refreshing = false;
	}
}

function appendHeartbeatObservation(data) {
	const heartbeatCount = Number(data.heartbeatCount);
	if (!Number.isInteger(heartbeatCount) || heartbeatCount < 0) return;
	if (previousHeartbeatCount === null) {
		previousHeartbeatCount = heartbeatCount;
		signalTrack.replaceChildren();
		if (heartbeatCount === 0) renderSignalTrack();
		else appendSignalNode("baseline", heartbeatCount, data.lastPingAt);
		return;
	}
	const added = Math.max(0, heartbeatCount - previousHeartbeatCount);
	for (let index = 0; index < Math.min(added, 24); index += 1) appendSignalNode("received", previousHeartbeatCount + index + 1, data.lastPingAt);
	if (added > 24) appendSignalNode("burst", heartbeatCount, data.lastPingAt, added - 24);
	previousHeartbeatCount = heartbeatCount;
}

function appendSignalNode(kind, count, lastPingAt, omitted = 0) {
	if (signalTrack.firstElementChild?.classList.contains("pulse-signal-empty")) signalTrack.replaceChildren();
	const node = document.createElement("i");
	node.className = `pulse-signal-node ${kind}`;
	node.title = omitted > 0 ? `${omitted + 24} heartbeats received between refreshes` : `Heartbeat #${count}${lastPingAt ? ` · ${formatDate(lastPingAt)}` : ""}`;
	node.setAttribute("aria-label", node.title);
	signalTrack.append(node);
	while (signalTrack.children.length > 36) signalTrack.firstElementChild?.remove();
	renderSignalTrack();
}

function renderSignalTrack() {
	if (signalTrack.children.length === 0) {
		const waiting = document.createElement("span");
		waiting.className = "pulse-signal-empty";
		waiting.textContent = "Waiting for the first heartbeat";
		signalTrack.append(waiting);
	}
}

function render(data) {
	dashboard.hidden = false; errorPanel.hidden = true; ownerPanel.hidden = false;
	connection.textContent = "LIVE"; connection.classList.add("online");
	name.textContent = data.name; description.textContent = data.description || "Heartbeat status without accounts or subscriptions.";
	stateBadge.dataset.state = data.state; stateBadge.querySelector("span").textContent = data.state.toUpperCase();
	heartbeatEndpoint = `${location.origin}/p/${data.publicId}`;
	publicEndpoint = `${location.origin}/pulse-public.html#${encodeURIComponent(data.publicId)}`;
	heartbeatUrl.value = heartbeatEndpoint;
	nameInput.value = data.name; descriptionInput.value = data.description; intervalInput.value = String(data.expectedIntervalSeconds); graceInput.value = String(data.graceSeconds);
	historyCount.textContent = `${Number(data.heartbeatCount).toLocaleString()} RECEIVED`;
	historyCopy.textContent = data.heartbeatCount === 0 ? "Waiting for the first authenticated heartbeat." : "Every new aggregate counter value adds a visual pulse. PULSE still stores only the latest timestamp and total count.";
	renderPublicControls(Boolean(data.publicStatusEnabled));
	updateClockLabels();
}

function renderPublicControls(enabled) {
	publicCard.dataset.enabled = String(enabled);
	publicUrl.disabled = !enabled;
	publicUrl.value = enabled ? publicEndpoint : "";
	publicUrl.placeholder = enabled ? "" : "Enable the public page to create its link";
	copyPublic.textContent = enabled ? "Copy public status link" : "Enable public page";
	openPublic.hidden = !enabled;
	disablePublic.hidden = !enabled;
	openPublic.href = enabled ? publicEndpoint : "/pulse-public.html";
	publicStatus.textContent = enabled ? "Public sharing is active. The public page exposes status only." : "Public sharing is off.";
}

function updateClockLabels() {
	if (current === null) return;
	last.textContent = current.lastPingAt ? formatDate(current.lastPingAt) : "Never";
	lastRelative.textContent = current.lastPingAt ? relativeTime(current.lastPingAt) : "Waiting for the first ping";
	const nextAt = current.lastPingAt ? new Date(new Date(current.lastPingAt).getTime() + current.expectedIntervalSeconds * 1_000) : null;
	next.textContent = nextAt ? formatDate(nextAt.toISOString()) : "After first ping";
	schedule.textContent = `Expected every ${duration(current.expectedIntervalSeconds)} · ${duration(current.graceSeconds)} grace`;
	expiry.textContent = remaining(current.expiresAt);
}

settings.addEventListener("submit", async (event) => {
	event.preventDefault();
	await saveSettings({
		name: nameInput.value,
		description: descriptionInput.value,
		expectedIntervalSeconds: Number(intervalInput.value),
		graceSeconds: Number(graceInput.value),
	}, settingsStatus);
});

copyPublic.addEventListener("click", async () => {
	if (current === null) return;
	if (!current.publicStatusEnabled) {
		await togglePublicPage(true);
		return;
	}
	await copyText(publicEndpoint, copyPublic, "Public status link copied", publicUrl);
});

disablePublic.addEventListener("click", () => void togglePublicPage(false));

async function togglePublicPage(enabled) {
	await saveSettings({ publicStatusEnabled: enabled }, publicStatus);
}

async function saveSettings(payload, statusTarget) {
	if (capability === null) return;
	statusTarget.textContent = "Saving…";
	try {
		const response = await fetch(`/api/pulse/${encodeURIComponent(capability.publicId)}`, { method: "PATCH", headers: { authorization: `Bearer ${capability.ownerToken}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
		if (!response.ok) {
			const error = await response.json().catch(() => null);
			throw new Error(error?.error === "invalid settings" ? scheduleGuidance() : "Could not save these settings.");
		}
		current = await response.json();
		render(current);
		statusTarget.textContent = current.publicStatusEnabled ? "Saved. Public status is enabled." : "Saved. Public status is disabled.";
	} catch (error) {
		statusTarget.textContent = error instanceof Error ? error.message : "Could not save these settings.";
	}
}

copyUrl.addEventListener("click", () => void copyText(heartbeatEndpoint, copyUrl, "Heartbeat URL copied", heartbeatUrl));
copyCurl.addEventListener("click", () => void copyText(`curl -X POST '${heartbeatEndpoint}' -H 'Authorization: Bearer ${capability?.pingToken ?? ""}'`, copyCurl, "curl command copied", heartbeatUrl));
destroy.addEventListener("click", async () => {
	if (capability === null || !window.confirm("Destroy this PULSE monitor, disable its public page, and erase both private capabilities?")) return;
	const response = await fetch(`/api/pulse/${encodeURIComponent(capability.publicId)}`, { method: "DELETE", headers: { authorization: `Bearer ${capability.ownerToken}` } });
	if (response.ok) { location.hash = ""; showError(); }
});

function parseCapability() {
	const hash = location.hash.slice(1);
	try {
		const normalized = hash.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - hash.length % 4) % 4);
		const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0))));
		return typeof parsed.publicId === "string" && typeof parsed.ownerToken === "string" && typeof parsed.pingToken === "string" ? parsed : null;
	} catch { return null; }
}
function parseLegacyPublicId() {
	const hash = location.hash.slice(1);
	if (!hash.startsWith("public=")) return null;
	const value = decodeURIComponent(hash.slice(7));
	return /^pulse_[A-Za-z0-9_-]{22,}$/u.test(value) ? value : null;
}
function showError() { dashboard.hidden = true; errorPanel.hidden = false; connection.textContent = "OFFLINE"; connection.classList.remove("online"); }
async function copyText(value, button, done, fallbackInput) { const original = button.textContent; try { await navigator.clipboard.writeText(value); button.textContent = done; } catch { fallbackInput.focus(); fallbackInput.select(); button.textContent = "Select and copy"; } window.setTimeout(() => { button.textContent = original; }, 1800); }
function scheduleGuidance() { return "Invalid schedule. Use whole seconds within the plan limits shown when the monitor was dispensed."; }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function relativeTime(value) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; }
function remaining(value) { const seconds = Math.max(0, Math.floor((new Date(value).getTime() - Date.now()) / 1_000)); return seconds >= 86400 ? `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; }
function duration(seconds) { return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`; }
