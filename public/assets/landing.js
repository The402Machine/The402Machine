const products = {
	catch: { kicker: "INBOUND WEBHOOK INBOX", name: "CATCH", detail: "Requests arrive. Nothing is forwarded.", stat: "402 requests · 4h 02m", meter: "34%" },
	whisper: { kicker: "CLIENT-ENCRYPTED HANDOFF", name: "WHISPER", detail: "The key stays with the people sharing it.", stat: "1 read · 7 days", meter: "58%" },
	pulse: { kicker: "TEMPORARY HEARTBEAT", name: "PULSE", detail: "One tiny ping becomes a clear status signal.", stat: "1,202 heartbeats · 4d 02h", meter: "78%" },
};

const kicker = document.querySelector("#machine-kicker");
const name = document.querySelector("#machine-product");
const detail = document.querySelector("#machine-detail");
const stat = document.querySelector("#machine-stat");
const meter = document.querySelector("#machine-meter");
const links = [...document.querySelectorAll("[data-machine-product]")];
const liveLine = document.querySelector("#live-platform-line");
const liveDispensed = document.querySelector("#live-dispensed");
const liveSats = document.querySelector("#live-sats");

if (liveLine instanceof HTMLElement && liveDispensed instanceof HTMLElement && liveSats instanceof HTMLElement) {
	void fetch("/api/stats", { headers: { accept: "application/json" } })
		.then(async (response) => {
			if (!response.ok) throw new Error("stats unavailable");
			const data = await response.json();
			if (!Number.isSafeInteger(data.dispensedResources) || !Number.isSafeInteger(data.receivedSats)) throw new Error("invalid stats");
			liveDispensed.textContent = new Intl.NumberFormat("en-US").format(data.dispensedResources);
			liveSats.textContent = new Intl.NumberFormat("en-US").format(data.receivedSats);
			liveLine.classList.add("loaded");
		})
		.catch(() => { liveLine.hidden = true; });
}

if (kicker instanceof HTMLElement && name instanceof HTMLElement && detail instanceof HTMLElement && stat instanceof HTMLElement && meter instanceof HTMLElement) {
	let active = 0;
	let timer;
	const show = (productName) => {
		const product = products[productName];
		if (product === undefined) return;
		active = Math.max(0, links.findIndex((link) => link.dataset.machineProduct === productName));
		kicker.textContent = product.kicker;
		name.textContent = product.name;
		detail.textContent = product.detail;
		stat.textContent = product.stat;
		meter.style.width = product.meter;
		links.forEach((link) => link.classList.toggle("active", link.dataset.machineProduct === productName));
	};
	const start = () => { timer = window.setInterval(() => { active = (active + 1) % links.length; show(links[active]?.dataset.machineProduct ?? "catch"); }, 3600); };
	links.forEach((link) => link.addEventListener("pointerenter", () => { window.clearInterval(timer); show(link.dataset.machineProduct ?? "catch"); }));
	links.forEach((link) => link.addEventListener("pointerleave", () => { window.clearInterval(timer); start(); }));
	show("catch");
	start();
}
