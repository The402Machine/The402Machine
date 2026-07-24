const dashboard = document.querySelector("#public-pulse-dashboard");
const errorPanel = document.querySelector("#public-pulse-error");
const connection = document.querySelector("#public-pulse-connection");
const stateBadge = document.querySelector("#public-pulse-state");
const name = document.querySelector("#public-pulse-name");
const description = document.querySelector("#public-pulse-description");
const summary = document.querySelector("#public-pulse-summary");
const relative = document.querySelector("#public-pulse-relative");
const signal = document.querySelector("#public-pulse-signal");

if ([dashboard, errorPanel, connection, stateBadge, name, description, summary, relative, signal].some((element) => element === null)) throw new Error("Public PULSE page is incomplete");

const publicId = parsePublicId();
let current = null;
if (publicId === null) showError();
else {
	void refresh();
	setInterval(() => void refresh(), 10_000);
	setInterval(renderClock, 1_000);
}

async function refresh() {
	try {
		const response = await fetch(`/api/pulse/${encodeURIComponent(publicId)}/public`, { cache: "no-store" });
		if (!response.ok) return showError();
		current = await response.json();
		render(current);
	} catch { connection.textContent = "RECONNECTING"; connection.classList.remove("online"); }
}

function render(data) {
	dashboard.hidden = false; errorPanel.hidden = true;
	connection.textContent = "LIVE"; connection.classList.add("online");
	name.textContent = data.name;
	description.textContent = data.description || "Public heartbeat status.";
	stateBadge.dataset.state = data.state;
	stateBadge.querySelector("span").textContent = data.state.toUpperCase();
	signal.dataset.state = data.state;
	renderClock();
}

function renderClock() {
	if (current === null) return;
	const labels = { waiting: "Waiting for first signal", operational: "All systems operational", late: "Heartbeat delayed", exhausted: "Monitor quota exhausted", expired: "Monitor expired" };
	summary.textContent = labels[current.state] ?? "Status unavailable";
	relative.textContent = current.lastPingAt ? `Last signal ${relativeTime(current.lastPingAt)}` : "No heartbeat received yet";
}

function parsePublicId() {
	const value = decodeURIComponent(location.hash.slice(1));
	return /^pulse_[A-Za-z0-9_-]{22,}$/u.test(value) ? value : null;
}
function showError() { dashboard.hidden = true; errorPanel.hidden = false; connection.textContent = "NOT SHARED"; connection.classList.remove("online"); }
function relativeTime(value) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; }
