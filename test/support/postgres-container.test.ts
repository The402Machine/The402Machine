import { describe, expect, it } from "vitest";

import { redactPostgresTestError } from "./postgres-container.js";

describe("PostgreSQL test container diagnostics", () => {
	it("redacts test passwords from Docker command failures", () => {
		const password = "synthetic-password";
		const message = `Command failed: docker run --env POSTGRES_PASSWORD=${password} postgres:17-alpine`;
		const redacted = redactPostgresTestError(message, password);
		expect(redacted).not.toContain(password);
		expect(redacted).toContain("POSTGRES_PASSWORD=[REDACTED]");
	});
});