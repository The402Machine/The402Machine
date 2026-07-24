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
const heartbeatUrl = document.querySelector("#pulse-heartbeat-url");
const publicUrl = document.querySelector("#pulse-public-url");
const copyUrl = document.querySelector("#pulse-copy-url");
const copyCurl = document.querySelector("#pulse-copy-curl");
const copyPublic = document.querySelector("#pulse-copy-public");
const settings = document.querySelector("#pulse-settings");
const nameInput = document.querySelector("#pulse-name-input");
const descriptionInput = document.querySelector("#pulse-description-input");
const intervalInput = document.querySelector("#pulse-interval-input");
const graceInput = document.querySelector("#pulse-grace-input");
const publicInput = document.querySelector("#pulse-public-input");
const settingsStatus = document.querySelector("#pulse-settings-status");
const destroy = document.querySelector("#pulse-destroy");

const capability = parseCapability();
let current = null;
let heartbeatEndpoint = "";
let publicEndpoint = "";
if (capability === null) showError(); else { void refresh(); setInterval(() => void refresh(), 15_000); }

async function refresh() {
	const owner = capability.ownerToken !== undefined;
	const endpoint = owner ? `/api/pulse/${encodeURIComponent(capability.publicId)}` : `/api/pulse/${encodeURIComponent(capability.publicId)}/public`;
	const response = await fetch(endpoint, { cache: "no-store", headers: owner ? { authorization: `Bearer ${capability.ownerToken}` } : {} });
	if (!response.ok) return showError();
	current = await response.json();
	render(current, owner);
}

function render(data, owner) {
	dashboard.hidden = false; errorPanel.hidden = true; connection.textContent = "LIVE"; connection.classList.add("online");
	name.textContent = data.name; description.textContent = data.description || "Heartbeat status without accounts or subscriptions.";
	stateBadge.dataset.state = data.state; stateBadge.querySelector("span").textContent = data.state.toUpperCase();
	last.textContent = data.lastPingAt ? formatDate(data.lastPingAt) : "Never";
	lastRelative.textContent = data.lastPingAt ? relativeTime(data.lastPingAt) : "Waiting for the first ping";
	const nextAt = data.lastPingAt ? new Date(new Date(data.lastPingAt).getTime() + data.expectedIntervalSeconds * 1000) : null;
	next.textContent = nextAt ? formatDate(nextAt.toISOString()) : "After first ping";
	schedule.textContent = `Expected every ${duration(data.expectedIntervalSeconds)} · ${duration(data.graceSeconds)} grace`;
	expiry.textContent = remaining(data.expiresAt);
	if (owner) {
		ownerPanel.hidden = false;
		heartbeatEndpoint = `${location.origin}/p/${data.publicId}`;
		publicEndpoint = `${location.origin}/pulse.html#public=${data.publicId}`;
		heartbeatUrl.value = heartbeatEndpoint;
		publicUrl.value = publicEndpoint;
		nameInput.value = data.name; descriptionInput.value = data.description; intervalInput.value = String(data.expectedIntervalSeconds); graceInput.value = String(data.graceSeconds); publicInput.checked = data.publicStatusEnabled;
	}
}

settings.addEventListener("submit", async (event) => {
	event.preventDefault();
	const response = await fetch(`/api/pulse/${encodeURIComponent(capability.publicId)}`, { method: "PATCH", headers: { authorization: `Bearer ${capability.ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: nameInput.value, description: descriptionInput.value, expectedIntervalSeconds: Number(intervalInput.value), graceSeconds: Number(graceInput.value), publicStatusEnabled: publicInput.checked }) });
	settingsStatus.textContent = response.ok ? "Saved." : "Could not save these settings.";
	if (response.ok) { current = await response.json(); render(current, true); }
});
copyUrl.addEventListener("click", () => void copyText(heartbeatEndpoint, copyUrl, "Heartbeat URL copied"));
copyCurl.addEventListener("click", () => void copyText(`curl -X POST '${heartbeatEndpoint}' -H 'Authorization: Bearer ${capability.pingToken}'`, copyCurl, "curl command copied"));
copyPublic.addEventListener("click", () => void copyText(publicEndpoint, copyPublic, "Public status link copied"));
destroy.addEventListener("click", async () => {
	if (!window.confirm("Destroy this PULSE monitor and erase both capabilities?")) return;
	const response = await fetch(`/api/pulse/${encodeURIComponent(capability.publicId)}`, { method: "DELETE", headers: { authorization: `Bearer ${capability.ownerToken}` } });
	if (response.ok) { location.hash = ""; showError(); }
});

function parseCapability() {
	const hash = location.hash.slice(1);
	if (hash.startsWith("public=")) return { publicId: hash.slice(7) };
	try { const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(hash.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0)))); return typeof parsed.publicId === "string" && typeof parsed.ownerToken === "string" && typeof parsed.pingToken === "string" ? parsed : null; } catch { return null; }
}
function showError() { dashboard.hidden = true; errorPanel.hidden = false; connection.textContent = "OFFLINE"; connection.classList.remove("online"); }
async function copyText(value, button, done) { try { await navigator.clipboard.writeText(value); button.textContent = done; } catch { heartbeatUrl.focus(); heartbeatUrl.select(); } }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function relativeTime(value) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; }
function remaining(value) { const seconds = Math.max(0, Math.floor((new Date(value).getTime() - Date.now()) / 1000)); return seconds >= 86400 ? `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; }
function duration(seconds) { return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`; }
