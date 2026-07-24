const REFRESH_INTERVAL_MS = 3_000;
const TIMELINE_SIZE = 16;
const SCHEDULE_STEPS = [20, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1_800, 3_600, 7_200, 14_400, 21_600, 43_200, 86_400, 172_800, 259_200, 604_800];

const dashboard = document.querySelector("#pulse-dashboard");
const errorPanel = document.querySelector("#pulse-error");
const connection = document.querySelector("#pulse-connection");
const ownerPanel = document.querySelector("#pulse-owner");
const stateBadge = document.querySelector("#pulse-state");
const refreshStatus = document.querySelector("#pulse-refresh-status");
const name = document.querySelector("#pulse-name");
const description = document.querySelector("#pulse-description");
const last = document.querySelector("#pulse-last");
const lastRelative = document.querySelector("#pulse-last-relative");
const next = document.querySelector("#pulse-next");
const schedule = document.querySelector("#pulse-schedule");
const expiry = document.querySelector("#pulse-expiry");
const timeline = document.querySelector("#pulse-timeline");
const historyCount = document.querySelector("#pulse-history-count");
const historyCopy = document.querySelector("#pulse-history-copy");
const quotaRemaining = document.querySelector("#pulse-quota-remaining");
const quotaUsed = document.querySelector("#pulse-quota-used");
const quotaMeter = document.querySelector("#pulse-quota-meter");
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
const intervalSlider = document.querySelector("#pulse-interval-slider");
const intervalHuman = document.querySelector("#pulse-interval-human");
const graceInput = document.querySelector("#pulse-grace-input");
const graceSlider = document.querySelector("#pulse-grace-slider");
const graceHuman = document.querySelector("#pulse-grace-human");
const settingsStatus = document.querySelector("#pulse-settings-status");
const destroy = document.querySelector("#pulse-destroy");

const required = [dashboard, errorPanel, connection, ownerPanel, stateBadge, refreshStatus, name, description, last, lastRelative, next, schedule, expiry, timeline, historyCount, historyCopy, quotaRemaining, quotaUsed, quotaMeter, heartbeatUrl, publicCard, publicUrl, copyUrl, copyCurl, copyPublic, openPublic, disablePublic, publicStatus, settings, nameInput, descriptionInput, intervalInput, intervalSlider, intervalHuman, graceInput, graceSlider, graceHuman, settingsStatus, destroy];
if (required.some((element) => element === null)) throw new Error("PULSE owner dashboard is incomplete");

const legacyPublicId = parseLegacyPublicId();
const capability = legacyPublicId === null ? parseCapability() : null;
let current = null;
let heartbeatEndpoint = "";
let publicEndpoint = "";
let previousHeartbeatCount = null;
let timelineStates = [];
let refreshing = false;
let nextRefreshAt = 0;

if (legacyPublicId !== null) location.replace(`/pulse-public#${encodeURIComponent(legacyPublicId)}`);
else if (capability === null) showError();
else {
	void refresh();
	setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	setInterval(updateClockLabels, 1_000);
}

async function refresh() {
	if (refreshing || capability === null) return;
	refreshing = true;
	updateRefreshStatus();
	try {
		const response = await fetch(`/api/pulse/${encodeURIComponent(capability.publicId)}`, { cache: "no-store", headers: { authorization: `Bearer ${capability.ownerToken}` } });
		if (!response.ok) return showError();
		const received = await response.json();
		appendHeartbeatObservation(received);
		current = received;
		nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
		render(received);
	} catch {
		connection.textContent = "RECONNECTING";
		connection.classList.remove("online");
		nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
	} finally {
		refreshing = false;
		updateRefreshStatus();
	}
}

function appendHeartbeatObservation(data) {
	const heartbeatCount = Number(data.heartbeatCount);
	if (!Number.isInteger(heartbeatCount) || heartbeatCount < 0) return;
	if (previousHeartbeatCount === null) {
		previousHeartbeatCount = heartbeatCount;
		timelineStates = heartbeatCount > 0 ? [{ kind: "baseline", count: heartbeatCount, lastPingAt: data.lastPingAt }] : [];
		renderTimeline();
		return;
	}
	const added = Math.max(0, heartbeatCount - previousHeartbeatCount);
	for (let index = 0; index < Math.min(added, TIMELINE_SIZE); index += 1) timelineStates.push({ kind: "received", count: previousHeartbeatCount + index + 1, lastPingAt: data.lastPingAt });
	if (added > TIMELINE_SIZE) timelineStates.push({ kind: "burst", count: heartbeatCount, lastPingAt: data.lastPingAt, omitted: added - TIMELINE_SIZE });
	timelineStates = timelineStates.slice(-TIMELINE_SIZE);
	previousHeartbeatCount = heartbeatCount;
	renderTimeline();
}

function renderTimeline() {
	if (timelineStates.length === 0) {
		const waiting = document.createElement("span");
		waiting.className = "pulse-timeline-empty";
		waiting.textContent = "Waiting for the first heartbeat";
		timeline.replaceChildren(waiting);
		return;
	}
	const leading = Array.from({ length: Math.max(0, TIMELINE_SIZE - timelineStates.length) }, () => {
		const cell = document.createElement("i");
		cell.className = "pulse-timeline-cell empty";
		cell.setAttribute("aria-hidden", "true");
		return cell;
	});
	const cells = timelineStates.map((observation) => {
		const cell = document.createElement("i");
		cell.className = `pulse-timeline-cell ${observation.kind}`;
		cell.title = observation.omitted > 0 ? `${observation.omitted + TIMELINE_SIZE} heartbeats received between refreshes` : `Heartbeat #${observation.count}${observation.lastPingAt ? ` · ${formatDate(observation.lastPingAt)}` : ""}`;
		cell.setAttribute("aria-label", cell.title);
		return cell;
	});
	timeline.replaceChildren(...leading, ...cells);
}

function render(data) {
	dashboard.hidden = false; errorPanel.hidden = true; ownerPanel.hidden = false;
	connection.textContent = "LIVE"; connection.classList.add("online");
	name.textContent = data.name; description.textContent = data.description || "Heartbeat status without accounts or subscriptions.";
	stateBadge.dataset.state = data.state; stateBadge.querySelector("span").textContent = data.state.toUpperCase();
	heartbeatEndpoint = `${location.origin}/p/${data.publicId}`;
	publicEndpoint = `${location.origin}/pulse-public#${encodeURIComponent(data.publicStatusId)}`;
	heartbeatUrl.value = heartbeatEndpoint;
	nameInput.value = data.name; descriptionInput.value = data.description;
	syncScheduleControls(data);
	historyCount.textContent = `${Number(data.heartbeatCount).toLocaleString()} RECEIVED`;
	historyCopy.textContent = data.heartbeatCount === 0 ? "Waiting for the first authenticated heartbeat." : "The timeline adds a bar when the aggregate heartbeat counter advances while this dashboard is open.";
	const remainingHeartbeats = Number(data.heartbeatsRemaining);
	quotaRemaining.textContent = remainingHeartbeats.toLocaleString();
	quotaUsed.textContent = `${Number(data.heartbeatCount).toLocaleString()} used of ${Number(data.heartbeatLimit).toLocaleString()}`;
	quotaMeter.style.width = `${Math.min(100, Number(data.heartbeatLimit) > 0 ? Number(data.heartbeatCount) / Number(data.heartbeatLimit) * 100 : 0)}%`;
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
	openPublic.href = enabled ? publicEndpoint : "/pulse-public";
	publicStatus.textContent = enabled ? "Public sharing is active through a separate read-only identifier. The heartbeat endpoint stays private." : "Public sharing is off.";
}

function updateClockLabels() {
	if (current === null) return updateRefreshStatus();
	last.textContent = current.lastPingAt ? formatDate(current.lastPingAt) : "Never";
	lastRelative.textContent = current.lastPingAt ? relativeTime(current.lastPingAt) : "Waiting for the first ping";
	const nextAt = current.lastPingAt ? new Date(new Date(current.lastPingAt).getTime() + current.expectedIntervalSeconds * 1_000) : null;
	next.textContent = nextAt ? formatDate(nextAt.toISOString()) : "After first ping";
	schedule.textContent = `Expected every ${formatScheduleDuration(current.expectedIntervalSeconds)} · ${formatScheduleDuration(current.graceSeconds)} grace`;
	expiry.textContent = remaining(current.expiresAt);
	updateRefreshStatus();
}

function updateRefreshStatus() {
	const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1_000));
	refreshStatus.textContent = refreshing ? "Updating…" : nextRefreshAt === 0 ? "Connecting…" : `Updating in ${seconds}s`;
}

function syncScheduleControls(data = current) {
	if (data === null) return;
	const minimums = { spark: { interval: 300, grace: 600 }, standard: { interval: 60, grace: 120 }, long: { interval: 20, grace: 60 } };
	const minimum = minimums[data.planId] ?? minimums.spark;
	intervalInput.min = String(minimum.interval); intervalSlider.min = String(closestScheduleStep(minimum.interval)); intervalSlider.max = String(SCHEDULE_STEPS.length - 1);
	graceInput.min = String(minimum.grace); graceSlider.min = String(closestScheduleStep(minimum.grace)); graceSlider.max = String(SCHEDULE_STEPS.length - 1);
	intervalInput.value = String(data.expectedIntervalSeconds); intervalSlider.value = String(closestScheduleStep(data.expectedIntervalSeconds));
	graceInput.value = String(data.graceSeconds); graceSlider.value = String(closestScheduleStep(data.graceSeconds));
	intervalHuman.textContent = formatScheduleDuration(Number(intervalInput.value));
	graceHuman.textContent = formatScheduleDuration(Number(graceInput.value));
}

function syncSchedulePair(source, target, human) {
	const fromSlider = source.type === "range";
	const seconds = fromSlider ? SCHEDULE_STEPS[Number(source.value)] ?? 60 : Number(source.value);
	target.value = fromSlider ? String(seconds) : String(closestScheduleStep(seconds));
	human.textContent = formatScheduleDuration(seconds);
}
intervalSlider.addEventListener("input", () => syncSchedulePair(intervalSlider, intervalInput, intervalHuman));
intervalInput.addEventListener("input", () => syncSchedulePair(intervalInput, intervalSlider, intervalHuman));
graceSlider.addEventListener("input", () => syncSchedulePair(graceSlider, graceInput, graceHuman));
graceInput.addEventListener("input", () => syncSchedulePair(graceInput, graceSlider, graceHuman));

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
async function togglePublicPage(enabled) { await saveSettings({ publicStatusEnabled: enabled }, publicStatus); }

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
		nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
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
	return /^pulse_(?:status_)?[A-Za-z0-9_-]{22,}$/u.test(value) ? value : null;
}
function showError() { dashboard.hidden = true; errorPanel.hidden = false; connection.textContent = "OFFLINE"; connection.classList.remove("online"); }
async function copyText(value, button, done, fallbackInput) { const original = button.textContent; try { await navigator.clipboard.writeText(value); button.textContent = done; } catch { fallbackInput.focus(); fallbackInput.select(); button.textContent = "Select and copy"; } window.setTimeout(() => { button.textContent = original; }, 1800); }
function scheduleGuidance() { return "Invalid schedule. Use a whole-second value between the plan minimum and 7 days."; }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function relativeTime(value) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; }
function remaining(value) { const seconds = Math.max(0, Math.floor((new Date(value).getTime() - Date.now()) / 1_000)); return seconds >= 86400 ? `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; }
function formatScheduleDuration(seconds) {
	if (!Number.isFinite(seconds)) return "—";
	if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
	if (seconds < 3600) return seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	if (seconds < 86400) return seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
	return seconds % 86400 === 0 ? `${seconds / 86400} day${seconds === 86400 ? "" : "s"}` : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
function closestScheduleStep(seconds) {
	let closest = 0;
	for (let index = 1; index < SCHEDULE_STEPS.length; index += 1) if (Math.abs(SCHEDULE_STEPS[index] - seconds) < Math.abs(SCHEDULE_STEPS[closest] - seconds)) closest = index;
	return closest;
}
