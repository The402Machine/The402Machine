const WHISPER_VERSION = 1;

export type EncryptedWhisper = {
	key: string;
	ciphertext: Buffer;
};

export async function encryptWhisper(plaintext: string): Promise<EncryptedWhisper> {
	const key = crypto.getRandomValues(new Uint8Array(32));
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, new TextEncoder().encode(plaintext));
	return { key: Buffer.from(key).toString("base64url"), ciphertext: Buffer.concat([Buffer.from([WHISPER_VERSION]), Buffer.from(nonce), Buffer.from(encrypted)]) };
}

export async function decryptWhisper(payload: Buffer, encodedKey: string): Promise<string> {
	if (payload.byteLength < 30 || payload[0] !== WHISPER_VERSION) throw new Error("Invalid WHISPER ciphertext");
	const key = Buffer.from(encodedKey, "base64url");
	if (key.byteLength !== 32) throw new Error("Invalid WHISPER key");
	const nonce = new Uint8Array(payload.subarray(1, 13));
	const ciphertext = new Uint8Array(payload.subarray(13));
	const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["decrypt"]);
	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, ciphertext);
	return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}