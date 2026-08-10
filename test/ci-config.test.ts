import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("repository automation", () => {
	it("runs the complete release gate in GitHub Actions", async () => {
		const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
		for (const expected of ["actions/checkout@v7", "actions/setup-node@v7", "node-version: 22", "npm ci", "npm run lint", "npm run typecheck", "npm run test -- --maxWorkers=1", "npm run build", "npm audit --omit=dev --audit-level=high", "docker compose --env-file .env.example", "-f .github/compose.ci.yml config", "docker build"]) expect(workflow).toContain(expected);
	});

	it("keeps dependencies and CodeQL monitored", async () => {
		const [dependabot, codeql] = await Promise.all([
			readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8"),
			readFile(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8"),
		]);
		expect(dependabot).toContain('package-ecosystem: "npm"');
		expect(dependabot).toContain('interval: "weekly"');
		expect(codeql).toContain("github/codeql-action/init@v4");
		expect(codeql).toContain("github/codeql-action/analyze@v4");
		expect(codeql).toContain("javascript-typescript");
	});
});
