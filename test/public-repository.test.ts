import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = async (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("public repository boundary", () => {
	it("describes only the public product boundary in the README", async () => {
		const readme = await read("README.md");

		expect(readme).toContain("Design principles");
		expect(readme).toContain("INSTALL.md");
		expect(readme).toContain("Interactive demos");
		expect(readme).toContain("open source under the ISC license");
		expect(readme).toContain("Payment protocols");
		expect(readme).toContain("HTTP Payment Authentication");
		expect(readme).toContain("L402");
		expect(readme).toContain("does not claim x402 compatibility");
		expect(readme).toContain("OpenAPI 3.1");
		expect(readme).toContain("GitHub Security Advisories");
		expect(readme).toContain("[ISC](LICENSE)");
		expect(readme).not.toContain("All rights reserved");
		expect(readme).not.toContain("—");
	});

	it("does not publish internal planning or agent instruction files", async () => {
		await expect(read("AGENTS.md")).rejects.toThrow();
		await expect(read("docs/architecture.md")).rejects.toThrow();
		await expect(read("docs/security.md")).rejects.toThrow();
		await expect(read("docs/product.md")).rejects.toThrow();
		await expect(read("docs/plans/2026-07-23-mvp.md")).rejects.toThrow();
	});

	it("publishes a repository license consistent with package and OpenAPI metadata", async () => {
		const [license, packageSource, openApiSource] = await Promise.all([
			read("LICENSE"),
			read("package.json"),
			read("public/openapi.json"),
		]);
		const packageJson = JSON.parse(packageSource) as { license?: string };
		const openApi = JSON.parse(openApiSource) as { info?: { license?: { identifier?: string; name?: string } } };

		expect(license).toContain("ISC License");
		expect(packageJson.license).toBe("ISC");
		expect(openApi.info?.license).toMatchObject({ identifier: "ISC", name: "ISC" });
	});
});
