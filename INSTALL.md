# Install and operate The402Machine

This document contains the technical and self-hosting material intentionally kept out of the user-facing README.

> GATE is a private beta and stays disabled by default. Enabling it requires `GATE_ENABLED=true`, a dedicated protocol key, and an Ed25519 receipt key pair. Do not enable GATE on a public deployment until projects and fixed routes have been provisioned through a private operator workflow.

### Private GATE operator workflow

Apply migrations before provisioning. The operator command writes directly to PostgreSQL, stores only capability hashes and never resolves the Lightning Address or creates an invoice:

```sh
npm run gate:operator -- create-project \
  --name "Weather API" \
  --lightning-address merchant@example.com \
  --route forecast:GET:/v1/forecast:42 \
  --allow-plaintext-capabilities
```

The explicit acknowledgement is mandatory because the command prints the project API capability and administrative capability exactly once. Run it only in a private interactive terminal, save both values directly in the operator's password manager, then clear terminal scrollback if appropriate. Do not run it from CI, command substitution or automation that captures stdout, and do not paste the output into tickets, logs, environment templates or public Postman environments.

Inspect non-secret policy later with:

```sh
npm run gate:operator -- inspect-project --project gate_project_REPLACE_ME
```

The operator workflow does not activate GATE. Runtime routes remain absent until `GATE_ENABLED=true` and all signing/protocol variables are valid.

### Production GATE activation

Generate dedicated values offline in a private operator shell. Do not reuse another product key and do not expose the output through chat, CI logs or shell tracing:

```bash
umask 077
openssl genpkey -algorithm Ed25519 -out gate-receipt-private.pem
openssl pkey -in gate-receipt-private.pem -pubout -out gate-receipt-public.pem
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Store the protocol key and both PEM files in the production secret manager. The application key variables contain base64url of the complete PEM bytes. Set `GATE_REALM=the402machine.com`, choose a stable unique `GATE_RECEIPT_KEY_ID`, and verify the Ed25519 pair offline before activation.

Activation order:

1. Back up the production database and deployment environment.
2. Install and validate the versioned Nginx configuration, keeping the previous files for rollback:

   ```bash
   test ! -e /etc/nginx/sites-available/the402machine.com || sudo cp /etc/nginx/sites-available/the402machine.com /etc/nginx/sites-available/the402machine.com.pre-gate
   test ! -e /etc/nginx/conf.d/the402machine-rate-limits.conf || sudo cp /etc/nginx/conf.d/the402machine-rate-limits.conf /etc/nginx/conf.d/the402machine-rate-limits.conf.pre-gate
   sudo install -m 0644 deploy/nginx/the402machine.com.conf /etc/nginx/sites-available/the402machine.com
   sudo install -m 0644 deploy/nginx/the402machine-rate-limits.conf /etc/nginx/conf.d/the402machine-rate-limits.conf
   sudo ln -sfn /etc/nginx/sites-available/the402machine.com /etc/nginx/sites-enabled/the402machine.com
   sudo nginx -t && sudo systemctl reload nginx
   ```

   If validation fails, restore each `.pre-gate` file that exists; remove any newly created target that has no backup and remove the new `sites-enabled` symlink if this was a first deployment. Then run `sudo nginx -t` before reloading Nginx. Do not reload after a failed validation.
3. Deploy the reviewed commit with `GATE_ENABLED=false`; require successful migrations and healthy web/worker services.
4. Confirm migrations `0020_gate.sql` and `0021_page_view_public_paths.sql` are recorded.
5. Configure realm, protocol key, receipt key pair and key ID; verify the published JWKS matches the configured public key.
6. Provision projects only in a private interactive terminal and transfer capabilities directly to the merchant secret manager.
7. Set `GATE_ENABLED=true`, recreate web and expiry-worker, then run provider-free checks: health, JWKS, unauthenticated 401 and malformed-request 400.
8. Do not send a valid authenticated quote until a payment test is explicitly approved. A valid quote resolves the merchant Lightning Address and can create an invoice.

## Requirements

- Node.js 22
- npm
- Docker with Compose
- PostgreSQL 17 for the production stack and integration tests

## Local development

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4020` or verify the service:

```bash
curl http://127.0.0.1:4020/health
```

When payment support is disabled, product pages and demos remain available while `/api/catalog` and payment routes are intentionally absent.

## Quality gates

Run the complete release gate before publishing:

```bash
npm run test -- --maxWorkers=1
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
docker compose --env-file .env.example config --quiet
git diff --check
```

PostgreSQL-backed tests use temporary containers. Do not point tests at production data.

## Configuration

Copy `.env.example` to an untracked `.env` for local work. Production Compose uses an untracked `.env.production` file.

Never commit or print:

- payment API keys;
- database passwords or connection strings;
- token peppers;
- wallet material, macaroons or private keys;
- delivery encryption keys;
- issued capabilities, invoices or BOLT11 strings.

### Core services

The production Compose stack runs:

- PostgreSQL;
- the ordered migration job;
- the web service;
- the expiry worker;
- an optional constrained payment bridge.

PostgreSQL must remain internal with no published host port.

## Lightning payment adapter

The LNbits adapter accepts only loopback HTTP or the explicitly pinned Docker gateway bridge, plus a dedicated invoice-only key.

`PAYMENT_DELIVERY_KEY` is a separate 32-byte base64url key used to encrypt recoverable delivery receipts. It must not be reused as the capability token pepper.

To enable interoperable agent payments, add:

```env
PAYMENT_AGENT_PROTOCOLS=true
PAYMENT_PROTOCOL_KEY=<32 random bytes encoded as base64url>
PAYMENT_REALM=the402machine.com
```

Generate the protocol key independently:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

`PAYMENT_PROTOCOL_KEY` binds HTTP Payment challenges and signs L402 macaroons. It cannot spend from LNbits or LND, but disclosure would permit forged payment credentials. Do not reuse `PAYMENT_DELIVERY_KEY`, `CATCH_TOKEN_PEPPER` or an LND macaroon.

Purchase endpoints then accept optional `X-Payment-Protocol: payment` for HTTP Payment Authentication with Lightning `charge`, or `X-Payment-Protocol: l402` for classic L402 compatibility. Omit the header for the existing JSON quote and polling flow. Both agent protocols bind the credential to product, plan, HTTP method, route, exact request-body bytes and invoice expiry. JSON retries must preserve whitespace and key order, not only semantic values. Never log preimages or macaroons, and never place them in URLs.

Migration `0017_payment_challenges.sql` adds the single-use challenge ledger. It stores only challenge identifiers, hashes, expiry and consumption timestamps. It never stores preimages, macaroons, invoices or dispensed capabilities.

Inspect a synthetic challenge without paying anything:

```sh
node examples/agent-payment-client.mjs http://127.0.0.1:4020 payment pulse spark
node examples/agent-payment-client.mjs http://127.0.0.1:4020 l402 pulse spark
```

The client exits after printing the invoice unless `PAYMENT_PREIMAGE_HEX` is set. Do not set it during deployment smoke tests and never pay a real invoice without explicit financial authorization.

Invoice creation uses the local payment order UUID as the provider `external_id`. Before creating an invoice, the broker looks up that identifier so an ambiguous lost response can recover the existing provider invoice instead of creating a duplicate.

Wallet or WebLN success is never the source of truth. Settlement, amount and payment hash are verified server-side before provisioning.

Before exposing either agent challenge, The402Machine also decodes the BOLT11 returned by LNbits and verifies that its embedded amount and payment hash match the order. The advertised challenge expiry never exceeds the invoice's own expiry.

## Reverse proxy and source IPs

`TRUSTED_PROXY` must be the exact reverse-proxy address as seen by Fastify. Leave it unset for direct development access. Never trust arbitrary forwarding headers.

CATCH resolves approximate IP metadata locally from the packaged GeoLite database. Visitor IPs are not sent to a third-party geolocation API.

## Product persistence rules

### CATCH

- Separate owner and ingest capabilities.
- Per-resource request, storage, payload and expiry limits.
- Final expiry or destruction removes events and credentials.
- The ingest endpoint is inbound-only.

### WHISPER

- Browser-side AES-256-GCM encryption.
- Server stores opaque ciphertext and a hashed read capability.
- The AES key remains in the URL fragment.
- Successful reads are serialized and counted atomically.
- The final allowed read clears ciphertext and credentials.
- Scheduled reveal remains anchored to order creation and leaves at least one usable hour before expiry.

### PULSE

- Separate owner and ping capabilities.
- Request bodies are ignored.
- Heartbeat quota consumption is atomic.
- Public status is optional and disabled by default.
- No forwarding, URL checks or notification egress.

## Migrations

Run migrations before recreating application services. Migration files are ordered and record their version in `schema_migrations`.

Forward migrations should be recoverable and repeatable where practical:

- use `ADD COLUMN IF NOT EXISTS`;
- drop named constraints before recreating them;
- give legacy resources an explicit safe default;
- test both a clean database and an upgraded historical schema.

## Deployment sequence

```bash
git fetch origin
git reset --hard <approved-commit>
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

Verify:

- database healthy;
- migration job exited successfully;
- web healthy;
- expiry worker running;
- `/health`, `/`, `/api`, `/demo`, `/catch`, `/whisper`, `/pulse` and `/pulse-public` return HTTP 200;
- PostgreSQL has no published port;
- production and repository commits match;
- service logs contain no fatal or migration errors.

Never create or pay a real invoice as part of a deployment smoke test without explicit financial authorization.

## Public repository boundary

Public documentation should describe product behavior and reproducible operation without exposing production topology, hidden hostnames, credentials or private deployment material.
