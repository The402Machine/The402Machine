const tabs = [...document.querySelectorAll("[data-demo-tab]")];
const panels = [...document.querySelectorAll("[data-demo-panel]")];
const demoNames = ["catch", "whisper", "pulse"];

const catchSeed = [
	mockEvent("POST", true, "application/json", { event: "deployment.finished", repository: "the402machine", status: "success", duration_ms: 18420 }, "Madrid", "ES", "203.0.113.42"),
	mockEvent("PUT", false, "application/x-www-form-urlencoded", "temperature=21.4&sensor=garage&battery=87", "Bilbao", "ES", "198.51.100.18"),
	mockEvent("POST", true, "application/json", { type: "invoice.settled", amount_sat: 402, order: "demo-order-184" }, "Frankfurt", "DE", "192.0.2.91"),
	mockEvent("PATCH", true, "application/json", { agent: "backup-runner", stage: "verify", progress: 100 }, "Helsinki", "FI", "203.0.113.77"),
	mockEvent("GET", false, "text/plain", "canary alive / edge=eu-west / latency=42ms", "Dublin", "IE", "198.51.100.203"),
	mockEvent("POST", true, "application/json", { sensor: "greenhouse", humidity: 58.2, alert: false }, "Valencia", "ES", "192.0.2.144"),
	mockEvent("DELETE", false, "text/plain", "demo cleanup request from test harness", "Lisbon", "PT", "203.0.113.9"),
];

const catchState = {
	events: catchSeed.map((event, index) => ({ ...event, id: `seed-${index}`, sequence: 17 - index, receivedAt: Date.now() - index * 67_000 })),
	sequence: 17,
	accepted: 17,
	storedBytes: 28 * 1024,
	page: 1,
	destroyed: false,
	lastGeneratedAt: Date.now(),
};

const catchElements = elements({
	events: "#demo-catch-events", search: "#demo-catch-search", access: "#demo-catch-access", method: "#demo-catch-method", contentType: "#demo-catch-content-type", pageSize: "#demo-catch-page-size", status: "#demo-catch-status", page: "#demo-catch-page", previous: "#demo-catch-prev", next: "#demo-catch-next", add: "#demo-catch-add", reset: "#demo-catch-reset", destroy: "#demo-catch-destroy", requests: "#demo-catch-requests", requestDetail: "#demo-catch-request-detail", requestMeter: "#demo-catch-request-meter", storage: "#demo-catch-storage", storageDetail: "#demo-catch-storage-detail", storageMeter: "#demo-catch-storage-meter", remaining: "#demo-catch-remaining",
});

const catchTemplates = [
	["POST", true, "application/json", () => ({ event: "build.completed", branch: ["main", "release", "docs"][randomInt(3)], duration_ms: randomInt(48_000) + 1_200 })],
	["POST", true, "application/json", () => ({ type: "payment.pending", amount_sat: [42, 402, 4002][randomInt(3)], attempt: randomInt(4) + 1 })],
	["PUT", false, "text/plain", () => `sensor=${["garage", "roof", "vault"][randomInt(3)]} temperature=${(18 + Math.random() * 8).toFixed(1)}C`],
	["PATCH", true, "application/json", () => ({ service: ["backup", "indexer", "worker"][randomInt(3)], status: "healthy", latency_ms: randomInt(180) + 14 })],
	["GET", false, "text/plain", () => `canary=${randomId(6)} region=eu-west latency=${randomInt(90) + 12}ms`],
];
const locations = [["Madrid", "ES", "203.0.113.42"], ["Amsterdam", "NL", "198.51.100.64"], ["Warsaw", "PL", "192.0.2.21"], ["Paris", "FR", "203.0.113.88"], ["Oslo", "NO", "198.51.100.119"]];

const whisperElements = elements({
	scenario: "#demo-whisper-scenario", state: "#demo-whisper-state", reads: "#demo-whisper-reads", status: "#demo-whisper-status", warning: "#demo-whisper-warning", schedule: "#demo-whisper-schedule", revealTime: "#demo-whisper-reveal-time", cipher: "#demo-whisper-cipher", cipherText: "#demo-whisper-ciphertext", message: "#demo-whisper-message", open: "#demo-whisper-open", close: "#demo-whisper-close", log: "#demo-whisper-log", reset: "#demo-whisper-reset",
});
const whisperState = { scenario: "ready", reads: 3, revealed: false, destroyed: false, revealAt: 0 };

const pulseElements = elements({
	name: "#demo-pulse-name", description: "#demo-pulse-description", state: "#demo-pulse-state", last: "#demo-pulse-last", lastRelative: "#demo-pulse-last-relative", next: "#demo-pulse-next", schedule: "#demo-pulse-schedule", expiry: "#demo-pulse-expiry", timeline: "#demo-pulse-timeline", historyCopy: "#demo-pulse-history-copy", ping: "#demo-pulse-ping", auto: "#demo-pulse-auto", exhaust: "#demo-pulse-exhaust", reset: "#demo-pulse-reset", destroy: "#demo-pulse-destroy", settings: "#demo-pulse-settings", nameInput: "#demo-pulse-name-input", descriptionInput: "#demo-pulse-description-input", intervalInput: "#demo-pulse-interval-input", graceInput: "#demo-pulse-grace-input", publicInput: "#demo-pulse-public-input", settingsStatus: "#demo-pulse-settings-status", publicPreview: "#demo-pulse-public-preview", publicName: "#demo-public-name", publicDescription: "#demo-public-description", publicState: "#demo-public-state", publicLast: "#demo-public-last",
});
const pulseState = {
	name: "Nightly backup",
	description: "Encrypted NAS snapshot and off-site verification.",
	interval: 12,
	grace: 8,
	lastPingAt: Date.now(),
	auto: true,
	exhausted: false,
	destroyed: false,
	publicEnabled: true,
	heartbeats: 318,
	history: ["ok", "ok", "ok", "late", "ok", "ok", "ok", "missed", "ok", "ok", "ok", "ok"],
};

function showDemo(name) {
	const selected = demoNames.includes(name) ? name : "catch";
	tabs.forEach((tab) => {
		const active = tab.dataset.demoTab === selected;
		tab.classList.toggle("active", active);
		tab.setAttribute("aria-selected", String(active));
		tab.tabIndex = active ? 0 : -1;
	});
	panels.forEach((panel) => {
		const active = panel.dataset.demoPanel === selected;
		panel.classList.toggle("active", active);
		panel.hidden = !active;
	});
	if (location.hash !== `#${selected}`) history.replaceState(null, "", `#${selected}`);
}

tabs.forEach((tab) => tab.addEventListener("click", () => showDemo(tab.dataset.demoTab ?? "catch")));
window.addEventListener("hashchange", () => showDemo(location.hash.slice(1)));
showDemo(location.hash.slice(1));

for (const button of document.querySelectorAll("[data-demo-copy]")) {
	button.addEventListener("click", () => demoCopyFeedback(button));
}

function createMockCatchEvent() {
	const template = catchTemplates[randomInt(catchTemplates.length)];
	const location = locations[randomInt(locations.length)];
	catchState.sequence += 1;
	catchState.accepted += 1;
	const payload = template[3]();
	const event = mockEvent(template[0], template[1], template[2], payload, location[0], location[1], location[2]);
	event.id = `live-${catchState.sequence}`;
	event.sequence = catchState.sequence;
	event.receivedAt = Date.now();
	catchState.storedBytes += byteLength(event.body);
	catchState.events.unshift(event);
	catchState.page = 1;
	return event;
}

function renderCatchEvents() {
	if (catchState.destroyed) {
		catchElements.events.replaceChildren(emptyState("CATCH destroyed in this simulation.", "Reload or press Reset inbox to restore it."));
		catchElements.status.textContent = "Both demo capabilities are now invalid.";
		return;
	}
	const query = catchElements.search.value.trim().toLowerCase();
	const filtered = catchState.events.filter((event) => {
		const accessMatches = !catchElements.access.value || (catchElements.access.value === "authenticated") === event.authenticated;
		const methodMatches = !catchElements.method.value || catchElements.method.value === event.method;
		const typeMatches = !catchElements.contentType.value || catchElements.contentType.value === event.contentType;
		const searchMatches = !query || event.body.toLowerCase().includes(query) || event.city.toLowerCase().includes(query);
		return accessMatches && methodMatches && typeMatches && searchMatches;
	});
	const size = Number(catchElements.pageSize.value);
	const pages = Math.max(1, Math.ceil(filtered.length / size));
	catchState.page = Math.min(catchState.page, pages);
	const events = filtered.slice((catchState.page - 1) * size, catchState.page * size);
	catchElements.events.replaceChildren(...events.map(catchEventCard));
	if (events.length === 0) catchElements.events.append(emptyState("No matching events.", "Try another filter or generate a new event."));
	catchElements.page.textContent = `Page ${catchState.page} of ${pages}`;
	catchElements.previous.disabled = catchState.page <= 1;
	catchElements.next.disabled = catchState.page >= pages;
	catchElements.status.textContent = `${filtered.length} matching synthetic event${filtered.length === 1 ? "" : "s"}. Newest first.`;
	renderCatchMetrics();
}

function catchEventCard(event) {
	const article = document.createElement("article");
	article.className = "portal-event demo-event";
	const head = document.createElement("div"); head.className = "portal-event-head";
	const identity = document.createElement("div");
	const sequence = document.createElement("strong"); sequence.textContent = `#${event.sequence}`;
	const method = document.createElement("b"); method.className = "portal-event-method"; method.textContent = event.method;
	const access = document.createElement("b"); access.className = `portal-event-access ${event.authenticated ? "authenticated" : "public"}`; access.textContent = event.authenticated ? "AUTHENTICATED" : "PUBLIC";
	const type = document.createElement("span"); type.textContent = event.contentType;
	const place = document.createElement("span"); place.className = "portal-event-location"; place.textContent = `${countryFlag(event.country)} ${event.city}`;
	identity.append(sequence, method, access, type, place);
	const time = document.createElement("time"); time.dateTime = new Date(event.receivedAt).toISOString(); time.textContent = relativeTime(event.receivedAt);
	head.append(identity, time);
	const body = document.createElement("pre"); body.textContent = event.body;
	const headers = detailBlock("Headers", JSON.stringify(event.headers, null, 2));
	const source = detailBlock("IP Location Info", JSON.stringify({ ip: event.ip, city: event.city, country: event.country, source: "synthetic demo" }, null, 2));
	const actions = document.createElement("div"); actions.className = "portal-event-actions";
	const inspect = document.createElement("button"); inspect.className = "button ghost"; inspect.type = "button"; inspect.textContent = "Inspect event";
	inspect.addEventListener("click", () => { headers.open = !headers.open; inspect.textContent = headers.open ? "Close inspector" : "Inspect event"; });
	const remove = document.createElement("button"); remove.className = "button danger ghost"; remove.type = "button"; remove.textContent = "Delete event";
	remove.addEventListener("click", () => { catchState.events = catchState.events.filter((candidate) => candidate.id !== event.id); catchState.storedBytes = Math.max(0, catchState.storedBytes - byteLength(event.body)); renderCatchEvents(); });
	actions.append(inspect, remove); article.append(head, body, headers, source, actions); return article;
}

function renderCatchMetrics() {
	const remaining = Math.max(0, 402 - catchState.accepted);
	catchElements.requests.textContent = `${catchState.accepted} / 402`;
	catchElements.requestDetail.textContent = `${remaining} requests remaining`;
	catchElements.requestMeter.style.width = `${Math.min(100, catchState.accepted / 402 * 100)}%`;
	catchElements.storage.textContent = `${formatBytes(catchState.storedBytes)} / 2 MiB`;
	catchElements.storageDetail.textContent = `${formatBytes(Math.max(0, 2 * 1024 * 1024 - catchState.storedBytes))} remaining`;
	catchElements.storageMeter.style.width = `${Math.min(100, catchState.storedBytes / (2 * 1024 * 1024) * 100)}%`;
}

function resetCatch() {
	catchState.events = catchSeed.map((event, index) => ({ ...event, id: `seed-${index}`, sequence: 17 - index, receivedAt: Date.now() - index * 67_000 }));
	catchState.sequence = 17; catchState.accepted = 17; catchState.storedBytes = 28 * 1024; catchState.page = 1; catchState.destroyed = false; catchState.lastGeneratedAt = Date.now();
	catchElements.add.disabled = false; catchElements.destroy.disabled = false; catchElements.search.value = ""; catchElements.access.value = ""; catchElements.method.value = ""; catchElements.contentType.value = "";
	renderCatchEvents();
}

for (const field of [catchElements.search, catchElements.access, catchElements.method, catchElements.contentType, catchElements.pageSize]) field.addEventListener(field === catchElements.search ? "input" : "change", () => { catchState.page = 1; renderCatchEvents(); });
catchElements.previous.addEventListener("click", () => { catchState.page = Math.max(1, catchState.page - 1); renderCatchEvents(); });
catchElements.next.addEventListener("click", () => { catchState.page += 1; renderCatchEvents(); });
catchElements.add.addEventListener("click", () => { if (!catchState.destroyed) { createMockCatchEvent(); renderCatchEvents(); catchElements.status.textContent = "New synthetic request received just now."; } });
catchElements.reset.addEventListener("click", resetCatch);
catchElements.destroy.addEventListener("click", () => { catchState.destroyed = true; catchState.events = []; catchState.storedBytes = 0; catchElements.add.disabled = true; catchElements.destroy.disabled = true; renderCatchEvents(); });

function resetWhisper() {
	whisperState.scenario = whisperElements.scenario.value;
	whisperState.reads = whisperState.scenario === "burn" ? 1 : whisperState.scenario === "ready" ? 3 : whisperState.scenario === "scheduled" ? 2 : 0;
	whisperState.revealed = false;
	whisperState.destroyed = whisperState.scenario === "expired";
	whisperState.revealAt = whisperState.scenario === "scheduled" ? Date.now() + 20_000 : 0;
	whisperElements.message.hidden = true;
	whisperElements.cipher.hidden = whisperState.destroyed;
	whisperElements.close.hidden = true;
	whisperElements.open.hidden = false;
	renderWhisperState();
}

function renderWhisperState() {
	const now = Date.now();
	const sealed = whisperState.scenario === "scheduled" && now < whisperState.revealAt;
	if (whisperState.destroyed || whisperState.reads <= 0) {
		whisperElements.state.textContent = whisperState.scenario === "expired" ? "EXPIRED" : "BURNED";
		whisperElements.state.dataset.status = "expired";
		whisperElements.reads.textContent = "0 READS LEFT";
		whisperElements.status.textContent = whisperState.scenario === "expired" ? "This delivery reached its hard expiry. The ciphertext and read credential are gone." : "The final demo read erased the synthetic server copy.";
		whisperElements.warning.innerHTML = "<strong>Terminal state.</strong> A real reader cannot recover an expired or burned WHISPER.";
		whisperElements.schedule.hidden = true; whisperElements.cipher.hidden = true; whisperElements.message.hidden = true; whisperElements.open.disabled = true; whisperElements.open.textContent = "WHISPER unavailable"; whisperElements.close.hidden = true;
		return;
	}
	whisperElements.reads.textContent = `${whisperState.reads} READ${whisperState.reads === 1 ? "" : "S"} LEFT`;
	whisperElements.open.disabled = sealed || whisperState.revealed;
	whisperElements.open.textContent = sealed ? "Sealed until reveal" : "Open WHISPER";
	whisperElements.schedule.hidden = !sealed;
	if (sealed) {
		whisperElements.state.textContent = "SEALED"; whisperElements.state.dataset.status = "suspended";
		whisperElements.status.textContent = "A real request now returns 425 Too Early with Retry-After. No read is used.";
		whisperElements.warning.innerHTML = "<strong>Scheduled reveal.</strong> Authentication succeeds, but ciphertext is not consumed before the reveal time.";
		whisperElements.revealTime.textContent = formatClock(whisperState.revealAt - now);
	} else {
		whisperElements.state.textContent = "READY"; whisperElements.state.dataset.status = "active";
		if (!whisperState.revealed) whisperElements.status.textContent = "The synthetic ciphertext is available. Confirm to decrypt it locally and use one demo read.";
		whisperElements.warning.innerHTML = whisperState.scenario === "burn" ? "<strong>Burn after first read.</strong> This successful opening immediately erases the synthetic server copy." : "<strong>Each opening counts.</strong> A real successful request consumes one read. The final allowed read erases the encrypted server copy.";
	}
}

function attemptWhisperRead() {
	if (whisperState.destroyed || whisperState.reads <= 0 || (whisperState.scenario === "scheduled" && Date.now() < whisperState.revealAt)) return;
	whisperState.reads -= 1; whisperState.revealed = true;
	whisperElements.cipher.hidden = true; whisperElements.message.hidden = false; whisperElements.open.hidden = true; whisperElements.close.hidden = false;
	whisperElements.log.textContent = `Decrypted locally at ${new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date())}. One demo read was used.`;
	whisperElements.status.textContent = whisperState.reads === 0 ? "Plaintext is visible. Closing it completes the final-read burn simulation." : `Plaintext is visible. ${whisperState.reads} demo read${whisperState.reads === 1 ? " remains" : "s remain"}.`;
	whisperElements.reads.textContent = `${whisperState.reads} READ${whisperState.reads === 1 ? "" : "S"} LEFT`;
}

whisperElements.scenario.addEventListener("change", resetWhisper);
whisperElements.reset.addEventListener("click", resetWhisper);
whisperElements.open.addEventListener("click", attemptWhisperRead);
whisperElements.close.addEventListener("click", () => {
	whisperElements.message.hidden = true; whisperElements.close.hidden = true; whisperState.revealed = false;
	if (whisperState.reads === 0) whisperState.destroyed = true;
	else { whisperElements.cipher.hidden = false; whisperElements.open.hidden = false; whisperElements.log.textContent = "Plaintext cleared from the screen. The remaining allowance is still simulated locally."; }
	renderWhisperState();
});

function simulatePulseHeartbeat(source = "manual") {
	if (pulseState.destroyed || pulseState.exhausted) return;
	pulseState.lastPingAt = Date.now(); pulseState.heartbeats += 1; pulseState.history.push("ok"); pulseState.history = pulseState.history.slice(-16);
	pulseElements.historyCopy.textContent = source === "auto" ? "A synthetic scheduled heartbeat arrived automatically." : "A synthetic heartbeat arrived from the demo control.";
	renderPulseDashboard();
}

function renderPulseDashboard() {
	const age = Math.max(0, Math.floor((Date.now() - pulseState.lastPingAt) / 1000));
	let state = "operational";
	if (pulseState.destroyed) state = "expired";
	else if (pulseState.exhausted) state = "exhausted";
	else if (age > pulseState.interval + pulseState.grace) state = "late";
	else if (pulseState.heartbeats === 0) state = "waiting";
	pulseElements.name.textContent = pulseState.name; pulseElements.description.textContent = pulseState.description;
	pulseElements.state.dataset.state = state; pulseElements.state.querySelector("span").textContent = state.toUpperCase();
	pulseElements.last.textContent = pulseState.destroyed ? "Unavailable" : age === 0 ? "Just now" : `${age}s ago`;
	pulseElements.lastRelative.textContent = pulseState.destroyed ? "Capabilities erased" : `${pulseState.heartbeats.toLocaleString()} of 1,202 lifetime heartbeats used`;
	const untilNext = Math.max(0, pulseState.interval - age);
	pulseElements.next.textContent = pulseState.destroyed || pulseState.exhausted ? "No further signal" : state === "late" ? "Overdue" : `In ${untilNext} seconds`;
	pulseElements.schedule.textContent = `Every ${pulseState.interval}s · ${pulseState.grace}s grace`;
	pulseElements.timeline.replaceChildren(...pulseState.history.map((item, index) => { const cell = document.createElement("i"); cell.className = item; cell.title = `${item} heartbeat ${index + 1}`; return cell; }));
	pulseElements.auto.textContent = pulseState.auto ? "Pause auto pings" : "Resume auto pings";
	pulseElements.ping.disabled = pulseState.destroyed || pulseState.exhausted; pulseElements.exhaust.disabled = pulseState.destroyed || pulseState.exhausted;
	pulseElements.publicPreview.hidden = !pulseState.publicEnabled || pulseState.destroyed;
	pulseElements.publicName.textContent = pulseState.name; pulseElements.publicDescription.textContent = pulseState.description; pulseElements.publicLast.textContent = pulseElements.last.textContent;
	pulseElements.publicState.textContent = state === "operational" ? "ALL SYSTEMS OPERATIONAL" : state === "late" ? "DELAYED HEARTBEAT" : state === "exhausted" ? "MONITOR EXHAUSTED" : "STATUS UNAVAILABLE";
	pulseElements.publicState.dataset.state = state;
}

function resetPulse() {
	Object.assign(pulseState, { name: "Nightly backup", description: "Encrypted NAS snapshot and off-site verification.", interval: 12, grace: 8, lastPingAt: Date.now(), auto: true, exhausted: false, destroyed: false, publicEnabled: true, heartbeats: 318, history: ["ok", "ok", "ok", "late", "ok", "ok", "ok", "missed", "ok", "ok", "ok", "ok"] });
	pulseElements.nameInput.value = pulseState.name; pulseElements.descriptionInput.value = pulseState.description; pulseElements.intervalInput.value = String(pulseState.interval); pulseElements.graceInput.value = String(pulseState.grace); pulseElements.publicInput.checked = true; pulseElements.settingsStatus.textContent = "Changes stay in this tab."; pulseElements.historyCopy.textContent = "Automatic demo heartbeats are running.";
	renderPulseDashboard();
}

pulseElements.ping.addEventListener("click", () => simulatePulseHeartbeat("manual"));
pulseElements.auto.addEventListener("click", () => { pulseState.auto = !pulseState.auto; pulseElements.historyCopy.textContent = pulseState.auto ? "Automatic demo heartbeats resumed." : "Automatic pings paused. Wait to see the late state."; renderPulseDashboard(); });
pulseElements.exhaust.addEventListener("click", () => { pulseState.exhausted = true; pulseState.auto = false; pulseState.history.push("missed"); pulseElements.historyCopy.textContent = "Lifetime quota exhausted. The ping capability is now invalid in this simulation."; renderPulseDashboard(); });
pulseElements.destroy.addEventListener("click", () => { pulseState.destroyed = true; pulseState.auto = false; pulseElements.historyCopy.textContent = "Both simulated capabilities were erased."; renderPulseDashboard(); });
pulseElements.reset.addEventListener("click", resetPulse);
pulseElements.settings.addEventListener("submit", (event) => {
	event.preventDefault();
	pulseState.name = pulseElements.nameInput.value.trim() || "Untitled monitor"; pulseState.description = pulseElements.descriptionInput.value.trim(); pulseState.interval = clamp(Number(pulseElements.intervalInput.value), 5, 60); pulseState.grace = clamp(Number(pulseElements.graceInput.value), 3, 60); pulseState.publicEnabled = pulseElements.publicInput.checked;
	pulseElements.settingsStatus.textContent = "Saved locally. The owner and public previews updated."; renderPulseDashboard();
});

setInterval(() => {
	const active = location.hash.slice(1) || "catch";
	if (active === "catch" && !catchState.destroyed && Date.now() - catchState.lastGeneratedAt >= 5_000 && Math.random() < 0.55) { catchState.lastGeneratedAt = Date.now(); createMockCatchEvent(); renderCatchEvents(); }
	if (active === "whisper") renderWhisperState();
	if (active === "pulse") {
		const age = (Date.now() - pulseState.lastPingAt) / 1000;
		if (pulseState.auto && !pulseState.destroyed && !pulseState.exhausted && age >= pulseState.interval) simulatePulseHeartbeat("auto");
		else renderPulseDashboard();
	}
}, 1000);

setInterval(() => {
	if (!catchState.destroyed) {
		const seconds = 4 * 3600 + 60 - Math.floor((Date.now() / 1000) % 60);
		catchElements.remaining.textContent = formatDuration(seconds);
	}
}, 1000);

function elements(selectors) {
	const result = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, document.querySelector(selector)]));
	if (Object.values(result).some((value) => value === null)) throw new Error("Demo dashboard is incomplete");
	return result;
}
function mockEvent(method, authenticated, contentType, payload, city, country, ip) { const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2); return { method, authenticated, contentType, body, city, country, ip, headers: { "content-type": contentType, "user-agent": "The402Machine-Demo/1.0", "x-demo-event": "true" } }; }
function detailBlock(label, value) { const details = document.createElement("details"); const summary = document.createElement("summary"); const pre = document.createElement("pre"); summary.textContent = label; pre.textContent = value; details.append(summary, pre); return details; }
function emptyState(title, copy) { const empty = document.createElement("div"); empty.className = "portal-empty"; const strong = document.createElement("strong"); strong.textContent = title; const span = document.createElement("span"); span.textContent = copy; empty.append(strong, span); return empty; }
function demoCopyFeedback(button) { const original = button.textContent; button.textContent = button.dataset.demoCopy ?? "Copied"; window.setTimeout(() => { button.textContent = original; }, 1400); }
function relativeTime(value) { const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000)); return seconds < 3 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`; }
function countryFlag(country) { return String.fromCodePoint(...country.split("").map((letter) => 127397 + letter.charCodeAt(0))); }
function byteLength(value) { return new TextEncoder().encode(value).byteLength; }
function formatBytes(value) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`; }
function formatDuration(seconds) { return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`; }
function formatClock(milliseconds) { const total = Math.max(0, Math.ceil(milliseconds / 1000)); return `00:${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function randomInt(maximum) { return Math.floor(Math.random() * maximum); }
function randomId(length) { const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join(""); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum)); }

resetCatch(); resetWhisper(); resetPulse();
