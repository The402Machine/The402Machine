const tabs = [...document.querySelectorAll("[data-demo-tab]")];
const panels = [...document.querySelectorAll("[data-demo-panel]")];

function showDemo(name) {
	tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.demoTab === name));
	panels.forEach((panel) => {
		const active = panel.dataset.demoPanel === name;
		panel.classList.toggle("active", active);
		panel.hidden = !active;
	});
	if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}

tabs.forEach((tab) => tab.addEventListener("click", () => showDemo(tab.dataset.demoTab ?? "catch")));
showDemo(["catch", "whisper", "pulse"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "catch");

document.querySelector("[data-demo-add]")?.addEventListener("click", (event) => {
	const button = event.currentTarget;
	if (!(button instanceof HTMLButtonElement)) return;
	button.textContent = "Demo event received";
	window.setTimeout(() => { button.textContent = "Simulate incoming event"; }, 1400);
});

document.querySelector("[data-demo-open]")?.addEventListener("click", (event) => {
	const message = document.querySelector("[data-demo-message]");
	const cipher = document.querySelector("[data-demo-cipher]");
	if (message instanceof HTMLElement) message.hidden = false;
	if (cipher instanceof HTMLElement) cipher.hidden = true;
	if (event.currentTarget instanceof HTMLButtonElement) event.currentTarget.textContent = "Decrypted locally";
});

let heartbeats = 318;
document.querySelector("[data-demo-ping]")?.addEventListener("click", () => {
	heartbeats += 1;
	const count = document.querySelector("[data-demo-heartbeats]");
	const last = document.querySelector("[data-demo-last]");
	if (count instanceof HTMLElement) count.textContent = `${heartbeats} / 1,202`;
	if (last instanceof HTMLElement) last.textContent = "just now";
});
