import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("expiry deployment", () => {
	it("ships migrations and supervises cleanup independently from the web process", async () => {
		const [compose, dockerfile] = await Promise.all([
			readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
			readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
		]);

		expect(compose).toContain("migrate:");
		expect(compose).toContain('command: ["node", "scripts/migrate.mjs"]');
		expect(compose).toContain("expiry-worker:");
		expect(compose).toContain('command: ["node", "dist/worker.js"]');
		expect(compose).toContain("lnbits-bridge:");
		expect(compose).toContain('network_mode: "host"');
		expect(compose).toContain("bind=172.30.240.1");
		expect(compose).toContain("TCP:127.0.0.1:2180");
		expect(compose).toContain("condition: service_completed_successfully");
		expect(dockerfile).toContain("COPY --chown=app:app migrations ./migrations");
		expect(dockerfile).toContain("COPY --chown=app:app scripts ./scripts");
	});
});
