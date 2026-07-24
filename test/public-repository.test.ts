import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = async (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("public repository boundary", () => {
	it("describes only the public product boundary in the README", async () => {
		const readme = await read("README.md");

		expect(readme).toContain("Design principles");
		expect(readme).toContain("INSTALL.md");
		expect(readme).toContain("Interactive demos");
		expect(readme).toContain("source-available");
		expect(readme).not.toContain("is an open-source");
	});

	it("does not publish internal planning or agent instruction files", async () => {
		await expect(read("AGENTS.md")).rejects.toThrow();
		await expect(read("docs/architecture.md")).rejects.toThrow();
		await expect(read("docs/security.md")).rejects.toThrow();
		await expect(read("docs/product.md")).rejects.toThrow();
		await expect(read("docs/plans/2026-07-23-mvp.md")).rejects.toThrow();
	});
});
