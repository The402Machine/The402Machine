const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const version = 1;

export async function sealWhisper(plaintext) {
	const rawKey = crypto.getRandomValues(new Uint8Array(32));
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encoder.encode(plaintext)));
	const payload = new Uint8Array(1 + nonce.length + encrypted.length);
	payload[0] = version;
	payload.set(nonce, 1);
	payload.set(encrypted, 13);
	return { ciphertext: payload, key: base64url(rawKey) };
}

export async function openWhisper(ciphertext, encodedKey) {
	if (ciphertext.length < 30 || ciphertext[0] !== version) throw new Error("Invalid WHISPER ciphertext");
	const rawKey = fromBase64url(encodedKey);
	if (rawKey.length !== 32) throw new Error("Invalid WHISPER key");
	const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ciphertext.slice(1, 13) }, key, ciphertext.slice(13));
	return decoder.decode(plaintext);
}

export function whisperLink(baseUrl, publicId, readToken, key) {
	const url = new URL(`/whisper.html`, baseUrl);
	url.searchParams.set("id", publicId);
	url.searchParams.set("token", readToken);
	url.hash = key;
	return url.toString();
}

export function fragmentKey() {
	return location.hash.slice(1);
}

function base64url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(value) {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}