<p align="center">
  <img src="public/favicon.svg" width="82" alt="The402Machine HTTP 402 icon" />
</p>

<h1 align="center">The402Machine</h1>

<p align="center">
  <strong>Pay once over Bitcoin Lightning. Receive a small Internet capability. Let it expire.</strong>
</p>

<p align="center">
  <a href="https://the402machine.com">Live service</a> ·
  <a href="https://the402machine.com/demo">Interactive demos</a> ·
  <a href="https://the402machine.com/api">API reference</a> ·
  <a href="INSTALL.md">Self-hosting guide</a>
</p>

<p align="center">
  <img alt="HTTP 402" src="https://img.shields.io/badge/HTTP-402-c7ff3d?style=flat-square&labelColor=080a08" />
  <img alt="L402" src="https://img.shields.io/badge/protocol-L402-c7ff3d?style=flat-square&labelColor=080a08" />
  <img alt="Bitcoin Lightning" src="https://img.shields.io/badge/payment-Bitcoin%20Lightning-ff6433?style=flat-square&labelColor=080a08" />
  <img alt="Self-hosted" src="https://img.shields.io/badge/deployment-self--hosted-65e7dd?style=flat-square&labelColor=080a08" />
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22-eef3e7?style=flat-square&labelColor=080a08" />
</p>

---

The402Machine sells temporary webhook inboxes, encrypted handoffs and heartbeat monitors over Bitcoin Lightning. A user or agent pays a BOLT11 invoice once, receives a capability, and uses it until its published quota or lifetime ends.

There are no customer accounts, subscriptions or prepaid balances. The server verifies settlement itself and provisions the resource in the same PostgreSQL transaction that consumes the payment challenge.

## What can you buy?

| Product | What you receive | Limits and privacy boundary |
| --- | --- | --- |
| **CATCH** | A private, inbound-only webhook inbox with separate ingest and owner capabilities. | Fixed request, storage, payload and lifetime limits. It never forwards traffic, calls user URLs or executes code. |
| **WHISPER** | An immediate or scheduled encrypted handoff with a bounded read allowance. | AES-256-GCM encryption happens in the browser. The server receives ciphertext, never the plaintext or AES key. |
| **PULSE** | A heartbeat endpoint, private owner dashboard and optional public status page. | Fixed lifetime and heartbeat quota. It stores no request body and performs no outbound checks or alerts. |

Every product uses the same price ladder:

| Plan | Price | Example lifetime |
| --- | ---: | --- |
| **Spark** | 42 sats | CATCH 4h 02m · WHISPER 7 days · PULSE 4d 02h |
| **Standard** | 402 sats | CATCH 40d 02h · WHISPER 42 days · PULSE 42 days |
| **Long** | 4,002 sats | CATCH 4 months + 2 days · WHISPER 402 days · PULSE 402 days |

Each product has its own quotas. Check the [live catalogue](https://the402machine.com/api/catalog) for the current limits before paying.

## Try it without paying

The [interactive demos](https://the402machine.com/demo) run entirely in the browser with synthetic data:

- inspect and delete sample CATCH events;
- decrypt a sample WHISPER message locally;
- send synthetic heartbeats to a PULSE dashboard and preview its public status page.

The demos do not create invoices, resources or payment credentials.

## Payment protocols

The current source tree supports three additive flows on the same purchase endpoints:

| Flow | Client | Settlement proof | Status |
| --- | --- | --- | --- |
| Native HTTP 402 | Browser checkout and simple clients | Server-side LNbits settlement polling | Stable project flow |
| HTTP Payment Authentication + Lightning `charge` | Agents following the current Payment Authentication draft | BOLT11 preimage plus server-side settlement verification | Experimental draft support |
| L402 | Existing Lightning/L402 clients | Binary v2 macaroon plus BOLT11 preimage | Compatibility adapter |

The native flow returns a JSON quote and lets the client poll for settlement. Agent clients request a challenge with `X-Payment-Protocol: payment` or `X-Payment-Protocol: l402`, pay the BOLT11 invoice, then repeat the same request with the corresponding `Authorization` credential.

Payment credentials are bound to the order, product, plan, HTTP method, route, exact request-body bytes and expiry. Successful redemption and resource provisioning happen atomically, so a challenge cannot provision twice.

The402Machine does not claim x402 compatibility. HTTP 402, Payment Authentication, L402 and x402 are separate contracts.

Protocol details and curl-level wire flows are documented in [`PAYMENT_PROTOCOLS.md`](PAYMENT_PROTOCOLS.md).

## Use the API

Public contracts and examples:

- [Human-readable API reference](https://the402machine.com/api)
- [OpenAPI 3.1](https://the402machine.com/openapi.json)
- [Postman collection](https://the402machine.com/the402machine.postman_collection.json)
- [`examples/agent-payment-client.mjs`](examples/agent-payment-client.mjs), a dependency-free Payment/L402 reference client

A minimal native quote request looks like this:

```bash
curl -i https://the402machine.com/api/payments/pulse \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pulse-example-001' \
  --data-binary '{"planId":"spark"}'
```

The server responds with `402 Payment Required`, a BOLT11 invoice and an order ID. Poll `GET /api/payments/{orderId}` after payment to receive the capability.

Request an L402 challenge by adding the protocol header:

```bash
curl -i https://the402machine.com/api/payments/pulse \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: l402-example-001' \
  -H 'X-Payment-Protocol: l402' \
  --data-binary '{"planId":"spark"}'
```

This returns `WWW-Authenticate: L402 macaroon="...", invoice="..."`. The retry must preserve the same method, route, idempotency key and body bytes. See [`PAYMENT_PROTOCOLS.md`](PAYMENT_PROTOCOLS.md) before implementing a client.

## Self-host it

The production stack is Node.js 22, Fastify, PostgreSQL 17 and Docker Compose. Lightning invoices come from a dedicated invoice-only LNbits wallet, which can be backed by the operator's own node. No external custodian or payment facilitator is required.

For a quick local look at the interface:

```bash
git clone https://github.com/The402Machine/The402Machine.git
cd The402Machine
npm ci
npm run dev
```

Open `http://127.0.0.1:4020`. Payments are disabled by default, so the public pages and demos work without wallet credentials. Enabling checkout, LNbits, migrations and production deployment requires the steps in [`INSTALL.md`](INSTALL.md).

## How it is built

- Server-confirmed payment hash, amount and settlement before provisioning
- BOLT11 amount, network, payment hash and expiry validation
- Idempotent invoice creation using the order UUID as the LNbits `external_id`
- Atomic PostgreSQL provisioning and single-use challenge consumption
- Encrypted recoverable delivery receipts at rest
- Capability-based owner, ingest, read and heartbeat access
- Internal PostgreSQL network with no published database port in Compose
- Read-only containers with dropped Linux capabilities

The release gate includes unit and PostgreSQL integration tests, lint, type checking, production builds, dependency audit, OpenAPI validation and Docker builds.

## Design principles

- A product performs one narrow job.
- Price, lifetime, quota and deletion behavior are visible before payment.
- Wallet callbacks and browser success states are never treated as proof of payment.
- Products cannot become proxies, redirectors or general-purpose compute.
- Expiry, quota exhaustion and destruction remove credentials and data at the database boundary.

## Project status

The live service is an experimental deployment. The native checkout is the established project flow; HTTP Payment Authentication follows an evolving Internet-Draft; L402 is provided as a compatibility adapter. Interfaces may change before a stable release.

The project is open source under the ISC license.

## Security

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/The402Machine/The402Machine/security/advisories/new). Do not include live capabilities, payment credentials, wallet material, invoices, preimages or production connection strings in a public issue.

## License

[ISC](LICENSE) © 2026 The402Machine contributors.
