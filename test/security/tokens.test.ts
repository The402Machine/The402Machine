import { describe, expect, it } from "vitest";

import {
	generateIngestToken,
	generateOwnerToken,
	hashToken,
	verifyToken,
} from "../../src/security/tokens.js";

const pepper = "test-only-server-side-pepper";

describe("opaque CATCH tokens", () => {
	it("generates distinct, role-prefixed tokens with at least 256 bits of encoded entropy", () => {
		const ingest = generateIngestToken();
		const owner = generateOwnerToken();

		expect(ingest).toMatch(/^catch_ing_[A-Za-z0-9_-]{43}$/);
		expect(owner).toMatch(/^catch_own_[A-Za-z0-9_-]{43}$/);
		expect(ingest).not.toBe(owner);
	});

	it("hashes and verifies an ingest token with a required pepper", () => {
		const token = generateIngestToken();
		const hash = hashToken("ingest", token, pepper);

		expect(hash).not.toContain(token);
		expect(verifyToken("ingest", token, hash, pepper)).toBe(true);
		expect(verifyToken("ingest", `${token}x`, hash, pepper)).toBe(false);
	});

	it("does not permit a token or hash to cross role boundaries", () => {
		const ingest = generateIngestToken();
		const owner = generateOwnerToken();
		const ingestHash = hashToken("ingest", ingest, pepper);
		const ownerHash = hashToken("owner", owner, pepper);

		expect(verifyToken("owner", ingest, ingestHash, pepper)).toBe(false);
		expect(verifyToken("ingest", owner, ownerHash, pepper)).toBe(false);
	});

	it.each([
		["non-hex characters", (hash: string) => `${hash.slice(0, -1)}z`],
		["trailing garbage", (hash: string) => `${hash}!`],
		["trailing newline", (hash: string) => `${hash}\n`],
		["odd length", (hash: string) => hash.slice(0, -1)],
		["truncated", (hash: string) => hash.slice(0, -2)],
		["oversized", (hash: string) => `${hash}00`],
	])("returns false without throwing for a %s expected hash", (_description, mutateHash) => {
		const token = generateIngestToken();
		const malformedHash = mutateHash(hashToken("ingest", token, pepper));

		expect(() => verifyToken("ingest", token, malformedHash, pepper)).not.toThrow();
		expect(verifyToken("ingest", token, malformedHash, pepper)).toBe(false);
	});

	it("requires a non-empty server-side pepper", () => {
		expect(() => hashToken("ingest", generateIngestToken(), "")).toThrow("A non-empty token pepper is required");
		expect(() => verifyToken("owner", generateOwnerToken(), "hash", "")).toThrow(
		"A non-empty token pepper is required",
	);
	});
});
