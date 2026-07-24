import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type WhisperApiRepository } from "../../src/app.js";
import { hashToken } from "../../src/security/tokens.js";
import { decryptWhisper, encryptWhisper } from "../../src/whisper/whisper-crypto.js";

const pepper = "whisper-test-pepper";
const provisioningSecret = "whisper-provisioning-secret";
const readToken = `catch_own_${"r".repeat(43)}`;

class FakeWhisperRepository implements WhisperApiRepository {
	public created: Parameters<WhisperApiRepository["create"]>[0] | null = null;
	public credentialHash: string | null = hashToken("owner", readToken, pepper);
	public body: Buffer | null = Buffer.from("opaque-ciphertext");
	public readsRemaining = 1;
	public availableAt = new Date(0);

	public create(input: Parameters<WhisperApiRepository["create"]>[0]): Promise<{ id: string; publicId: string }> {
		this.created = input;
		return Promise.resolve({ id: "whisper-id", publicId: input.publicId });
	}

	public getCredentialHash(): Promise<string | null> { return Promise.resolve(this.credentialHash); }
	public getAvailability(): Promise<{ state: "scheduled" | "available"; revealAt: Date; readCount: number; readLimit: number } | null> {
		return Promise.resolve({ state: this.availableAt.getTime() > Date.now() ? "scheduled" : "available", revealAt: this.availableAt, readCount: 0, readLimit: this.readsRemaining });
	}
	public consume(): Promise<Buffer | null> {
		if (this.body === null || this.readsRemaining <= 0) return Promise.resolve(null);
		const current = this.body;
		this.readsRemaining -= 1;
		if (this.readsRemaining === 0) {
			this.body = null;
			this.credentialHash = null;
		}
		return Promise.resolve(current);
	}
}

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("WHISPER HTTP API", () => {
	it("encrypts and decrypts in the client while keeping the key out of ciphertext", async () => {
		const encrypted = await encryptWhisper("meet at 4:02");
		expect(encrypted.ciphertext.toString("utf8")).not.toContain("meet at 4:02");
		expect(encrypted.ciphertext.toString("base64url")).not.toContain(encrypted.key);
		expect(await decryptWhisper(encrypted.ciphertext, encrypted.key)).toBe("meet at 4:02");
	});
	it("stores only bounded opaque ciphertext and returns the read credential once", async () => {
		const repository = new FakeWhisperRepository();
		const app = buildApp({ whisper: { repository, tokenPepper: pepper, provisioningEnabled: true, provisioningSecret } });
		apps.push(app);
		const ciphertext = Buffer.from("opaque-client-ciphertext");
		const response = await app.inject({
			method: "POST",
			url: "/internal/whisper/provision",
			headers: { ...bearer(provisioningSecret), "content-type": "application/octet-stream", "x-whisper-plan": "spark" },
			payload: ciphertext,
		});
		expect(response.statusCode).toBe(201);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(repository.created?.ciphertext).toEqual(ciphertext);
		const responseBody: unknown = response.json();
		expect(typeof responseBody).toBe("object");
		const responseRecord = responseBody as Record<string, unknown>;
		expect(responseRecord.publicId).toEqual(expect.stringMatching(/^whisper_/));
		expect(responseRecord.readToken).toEqual(expect.stringMatching(/^catch_own_/));
	});

	it("returns ciphertext once and then hides resource existence", async () => {
		const repository = new FakeWhisperRepository();
		const app = buildApp({ whisper: { repository, tokenPepper: pepper } });
		apps.push(app);
		const first = await app.inject({ method: "GET", url: "/w/whisper_test", headers: bearer(readToken) });
		expect(first.statusCode).toBe(200);
		expect(first.headers["content-type"]).toContain("application/octet-stream");
		expect(first.body).toBe("opaque-ciphertext");
		expect(first.headers["cache-control"]).toBe("no-store");
		const second = await app.inject({ method: "GET", url: "/w/whisper_test", headers: bearer(readToken) });
		expect(second.statusCode).toBe(404);
	});

	it("does not spend a read before the scheduled reveal time", async () => {
		const repository = new FakeWhisperRepository();
		repository.availableAt = new Date(Date.now() + 60_000);
		const app = buildApp({ whisper: { repository, tokenPepper: pepper } });
		apps.push(app);
		const response = await app.inject({ method: "GET", url: "/w/whisper_test", headers: bearer(readToken) });
		expect(response.statusCode).toBe(425);
		expect(response.headers["retry-after"]).toBeDefined();
		expect(response.json()).toMatchObject({ error: "not revealed", revealAt: repository.availableAt.toISOString() });
		expect(repository.readsRemaining).toBe(1);
		expect(repository.body?.toString()).toBe("opaque-ciphertext");
	});

	it("allows a Standard WHISPER to be read up to 42 times", async () => {
		const repository = new FakeWhisperRepository();
		repository.readsRemaining = 42;
		const app = buildApp({ whisper: { repository, tokenPepper: pepper } });
		apps.push(app);
		for (let read = 0; read < 42; read += 1) {
			const response = await app.inject({ method: "GET", url: "/w/whisper_test", headers: bearer(readToken), remoteAddress: `127.0.0.${read + 1}` });
			expect(response.statusCode).toBe(200);
		}
		const exhausted = await app.inject({ method: "GET", url: "/w/whisper_test", headers: bearer(readToken), remoteAddress: "127.0.1.1" });
		expect(exhausted.statusCode).toBe(404);
	});

	it("rejects plaintext media types and oversized ciphertext", async () => {
		const repository = new FakeWhisperRepository();
		const app = buildApp({ whisper: { repository, tokenPepper: pepper, provisioningEnabled: true, provisioningSecret } });
		apps.push(app);
		const plaintext = await app.inject({ method: "POST", url: "/internal/whisper/provision", headers: { ...bearer(provisioningSecret), "content-type": "text/plain", "x-whisper-plan": "spark" }, payload: "secret" });
		expect(plaintext.statusCode).toBe(400);
		const oversized = await app.inject({ method: "POST", url: "/internal/whisper/provision", headers: { ...bearer(provisioningSecret), "content-type": "application/octet-stream", "x-whisper-plan": "spark" }, payload: Buffer.alloc(4_215_276 + 1) });
		expect(oversized.statusCode).toBeGreaterThanOrEqual(400);
		expect(repository.created).toBeNull();
	});

	it("accepts Long provisioning with the longer WHISPER lifetime", async () => {
		const repository = new FakeWhisperRepository();
		const app = buildApp({ whisper: { repository, tokenPepper: pepper, provisioningEnabled: true, provisioningSecret } });
		apps.push(app);
		const response = await app.inject({
			method: "POST",
			url: "/internal/whisper/provision",
			headers: { ...bearer(provisioningSecret), "content-type": "application/octet-stream", "x-whisper-plan": "long" },
			payload: Buffer.from("opaque-client-ciphertext"),
		});

		expect(response.statusCode).toBe(201);
		expect(repository.created?.planId).toBe("long");
	});
});