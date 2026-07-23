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
});