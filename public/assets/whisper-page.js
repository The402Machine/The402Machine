import { fragmentKey, openWhisper } from "/assets/whisper.js";

const button = document.querySelector("#open");
const status = document.querySelector("#status");
const message = document.querySelector("#message");

if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement) || !(message instanceof HTMLElement)) {
	throw new Error("WHISPER page is incomplete");
}

button.addEventListener("click", async () => {
	if (!window.confirm("Open this WHISPER now? This uses one available read. If it is the final read, the encrypted server copy will be deleted.")) return;
	button.disabled = true;
	try {
		const query = new URLSearchParams(location.search);
		const response = await fetch(`/w/${encodeURIComponent(query.get("id") ?? "")}`, {
			headers: { authorization: "Bearer " + (query.get("token") ?? "") },
			cache: "no-store",
		});
		if (response.status === 425) {
			const schedule = await response.json();
			const revealAt = typeof schedule.revealAt === "string" ? new Date(schedule.revealAt) : null;
			throw new Error(revealAt !== null && !Number.isNaN(revealAt.getTime()) ? `This WHISPER is sealed until ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(revealAt)}. No read was used.` : "This WHISPER is not revealed yet. No read was used.");
		}
		if (!response.ok) throw new Error("WHISPER is unavailable, expired, or has no reads remaining.");
		message.textContent = await openWhisper(new Uint8Array(await response.arrayBuffer()), fragmentKey());
		message.hidden = false;
		status.textContent = "Decrypted locally. This opening used one read; reloading will use another if any remain.";
		button.hidden = true;
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Could not open WHISPER.";
		button.disabled = false;
	}
});
