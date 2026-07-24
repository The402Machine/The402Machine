# The402Machine

> **Insert sats. Receive a tiny piece of the Internet. Use it. Watch it disappear.**

The402Machine is a source-available vending machine for temporary Internet appliances designed to be paid with Bitcoin over Lightning. No account, subscription, credit balance, or custodial payment processor.

## First cartridges

### CATCH

A private, inbound-only webhook inbox with hard request, storage, and lifetime limits.

- **Spark:** 4 hours 2 minutes, 402 requests, 2 MiB total, 64 KiB per request — **42 sats**.
- **Standard:** 40 days 2 hours, 4,020 requests, 20 MiB total, 256 KiB per request — **402 sats**.
- **Long:** 4 months 2 days, 40,200 requests, 200 MiB total, 1 MiB per request — **4,002 sats**.

CATCH accepts bounded POST requests and never forwards, executes, or calls back into user-provided destinations.

When LNbits payments are enabled, the public flow is:

```text
POST /api/payments/catch        Idempotency-Key: <8-128 chars>  {"planId":"spark|standard|long"}
GET  /api/payments/<order-id>   returns 402 while pending, then the CATCH credentials
```

Concurrent retries reuse one invoice. After server-side settlement verification, CATCH provisioning and an encrypted delivery receipt are committed in one PostgreSQL transaction.

### WHISPER

An encrypted whisper that disappears after its first successful read or when its selected lifetime ends. The server accepts only bounded opaque ciphertext; encryption and decryption belong to the client.

The browser helper uses AES-256-GCM. The server receives ciphertext and a read credential, but not the AES key: the key stays in the URL fragment (`#...`). A successful read atomically clears both the ciphertext and read-token hash.

## Product boundary

The402Machine sells closed functions, never general computing capability. It will not offer arbitrary code, proxies, redirects, tunnels, mutable public APIs, configurable HTTP responses, or user-controlled outbound requests.

## Current status

The public landing page and Lightning checkout are online. CATCH and WHISPER are implemented, including bounded ingestion, encrypted read-once delivery, private access, transactional quotas, expiry cleanup, and PostgreSQL persistence. The first external CATCH purchase has been verified end to end.

Current plan ladder:

- Spark: 42 sats
- Standard: 402 sats
- Long: 4,002 sats

CATCH uses lifetimes of 4h 02m, 40d 02h, and 4 months + 2 days while scaling request, storage, and per-request payload quotas. WHISPER uses unread windows of 7, 42, and 402 days; every plan remains one-read, client-encrypted, and holds up to 4.02 MiB of ciphertext.

## CATCH guarantees

- Accepts only bounded `POST` bodies in JSON, text, or simple form format.
- Returns a fixed `204 No Content` response after successful ingestion.
- Uses separate ingest and owner credentials.
- Never executes code, forwards requests, calls user destinations, or exposes stored events publicly.
- Stops accepting data when its request, storage, lifetime, suspension, or destruction fuse is reached.
- Erases stored events and credentials when the cartridge expires or is destroyed.

## Local development

Requirements:

- Node.js 22
- npm
- Docker, for PostgreSQL integration tests and the production stack

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4020` or check:

```bash
curl http://127.0.0.1:4020/health
```

Quality gates:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

## Configuration

Copy `.env.example` to `.env` for local development. Production Compose uses an untracked `.env.production` file and runs PostgreSQL, migrations, the web service, and the expiry worker. Never commit payment credentials, database passwords, token peppers, wallet material, private keys, macaroons, or deployment secrets.

The LNbits adapter accepts only loopback HTTP or the pinned Docker gateway bridge, plus an invoice-only key. A constrained sidecar publishes the existing host-loopback tunnel only on the pinned Docker gateway address. `PAYMENT_DELIVERY_KEY` is a separate 32-byte base64url key used to encrypt recoverable credentials for idempotent delivery; it must not be reused as the CATCH token pepper.

Invoice creation uses the payment order UUID as LNbits `external_id`. Before creating an invoice, the broker looks up that stable identifier so retries can recover an invoice whose response was lost instead of blindly creating another one.

`TRUSTED_PROXY` must be the reverse proxy address as seen by Fastify. Leave it unset for direct development access; never trust arbitrary forwarding headers. The production Compose file pins its edge subnet and gateway so this trust boundary cannot drift silently.

CATCH stores the trusted request IP and resolves approximate city/country data locally from the packaged GeoLite database. Visitor IPs are not sent to third-party geolocation services.

## Security

Please report security issues privately rather than opening a public issue. A dedicated security contact and disclosure policy will be published before payments are enabled.

## License

All rights reserved while the product and abuse model are being validated.
