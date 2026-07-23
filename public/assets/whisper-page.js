import { fragmentKey, openWhisper } from "/assets/whisper.js";

const button = document.querySelector("#open");
const status = document.querySelector("#status");
const message = document.querySelector("#message");

if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement) || !(message instanceof HTMLElement)) {
	throw new Error("WHISPER page is incomplete");
}

button.addEventListener("click", async () => {
	button.disabled = true;
	try {
		const query = new URLSearchParams(location.search);
		const response = await fetch(`/w/${encodeURIComponent(query.get("id") ?? "")}`, {
			headers: { authorization: `Bearer ${query.get("token") ?? ""}` },
			cache: "no-store",
		});
		if (!response.ok) throw new Error("WHISPER is unavailable or has already been read.");
		message.textContent = await openWhisper(new Uint8Array(await response.arrayBuffer()), fragmentKey());
		message.hidden = false;
		status.textContent = "Decrypted locally. Reloading cannot retrieve it again.";
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Could not open WHISPER.";
	}
});
