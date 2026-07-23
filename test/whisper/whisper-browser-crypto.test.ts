import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("WHISPER browser cryptography", () => {
	it("ships a browser client that encrypts plaintext locally and keeps the AES key in the URL fragment", async () => {
		const source = await readFile(new URL("../../public/assets/whisper.js", import.meta.url), "utf8");
		expect(source).toContain("crypto.subtle.encrypt");
		expect(source).toContain("crypto.subtle.decrypt");
		expect(source).toContain("location.hash");
		expect(source).not.toContain("?key=");
	});

	it("does not request the destructive read until the recipient confirms", async () => {
		const source = await readFile(new URL("../../public/assets/whisper-page.js", import.meta.url), "utf8");
		const confirmation = source.indexOf("window.confirm");
		const consume = source.indexOf("fetch(`/w/");

		expect(confirmation).toBeGreaterThanOrEqual(0);
		expect(consume).toBeGreaterThan(confirmation);
		expect(source).toContain("button.disabled = false");
	});
});