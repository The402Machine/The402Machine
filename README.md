<p align="center">
  <img src="public/favicon.svg" width="82" alt="The402Machine 402 icon" />
</p>

<h1 align="center">The402Machine</h1>

<p align="center">
  <strong>Insert sats. Receive a tiny piece of the Internet. Watch it disappear.</strong>
</p>

<p align="center">
  <a href="https://the402machine.com">Live machine</a> ·
  <a href="https://the402machine.com/demo">Interactive demos</a> ·
  <a href="https://the402machine.com/api">API reference</a> ·
  <a href="INSTALL.md">Self-hosting guide</a>
</p>

<p align="center">
  <img alt="HTTP 402" src="https://img.shields.io/badge/HTTP-402-c7ff3d?style=flat-square&labelColor=080a08" />
  <img alt="Lightning" src="https://img.shields.io/badge/payment-Lightning-ff6433?style=flat-square&labelColor=080a08" />
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22-eef3e7?style=flat-square&labelColor=080a08" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/storage-PostgreSQL-65e7dd?style=flat-square&labelColor=080a08" />
</p>

---

The402Machine is a source-available vending machine for small, temporary Internet capabilities paid once over Bitcoin Lightning.

No account. No subscription. No credit balance. Every product has a visible lifetime or quota and a defined ending.

## The cartridges

| Product | What it does | What it never does |
| --- | --- | --- |
| **CATCH** | Receives bounded webhook requests in a private inbox with event inspection and deletion controls. | It does not forward traffic, call user URLs or execute code. |
| **WHISPER** | Delivers a client-encrypted handoff immediately or at a scheduled reveal time, with a bounded read allowance. | The server never receives the plaintext or AES key. |
| **PULSE** | Turns authenticated heartbeats into a private dashboard and optional public status page. | It stores no request body, performs no outbound checks and sends no alerts. |

### One simple price ladder

| Plan | Price | Typical role |
| --- | ---: | --- |
| **Spark** | 42 sats | Short tests, handoffs and jobs |
| **Standard** | 402 sats | Useful production-sized temporary work |
| **Long** | 4,002 sats | Longer-running bounded infrastructure |

Each product applies its own lifetime and quota. The live catalogue is the source of truth.

## See it before buying

The [demo area](https://the402machine.com/demo) contains local, read-only previews of:

- a CATCH inbox populated with sample events;
- a WHISPER handoff decrypted entirely in the browser;
- a PULSE heartbeat dashboard with interactive status updates.

The demos create no invoice, resource, capability or payment request.

## Design principles

- **Closed functions:** one product, one narrow job.
- **Visible fuses:** duration, quota and destruction policy are shown before payment.
- **Server-confirmed settlement:** wallet callbacks are never treated as proof of payment.
- **Capability-based access:** no customer accounts or recovery workflow.
- **Fail closed:** provisioning, quota consumption and final deletion are transactional.
- **No hidden egress:** products do not become proxies, redirectors or generic compute.

## API first

The browser checkout and owner interfaces sit on the same HTTP API available to scripts and agents.

Agents can choose one of three additive payment flows on the existing purchase endpoints:

- Native HTTP 402 JSON quote plus settlement polling.
- HTTP Payment Authentication with the Lightning `charge` intent, BOLT11 and preimage proof.
- Classic L402 compatibility using a request-bound macaroon and payment preimage.

No external custodian or mandatory facilitator is required. The self-hosted deployment continues to use an invoice-only LNbits wallet backed by the operator's Lightning node. All three flows reuse the same payment order, server-side settlement verification and atomic provisioning path.

This does **not** claim Coinbase x402 compatibility. HTTP 402, HTTP Payment Authentication, x402 and L402 are distinct contracts.

Read the dedicated [API reference](https://the402machine.com/api). Machine-readable contracts are available as [OpenAPI 3.1](https://the402machine.com/openapi.json) and a [Postman collection](https://the402machine.com/the402machine.postman_collection.json).

A dependency-free reference client is included at [`examples/agent-payment-client.mjs`](examples/agent-payment-client.mjs). It obtains either challenge, prints the BOLT11 invoice, and only submits a preimage when `PAYMENT_PREIMAGE_HEX` is explicitly provided.

See [`PAYMENT_PROTOCOLS.md`](PAYMENT_PROTOCOLS.md) for the compatibility matrix, wire flows, replay protection and the explicit x402 non-claim.

## Run your own machine

Installation, configuration, migrations, payment adapter details, security boundaries and release checks live in **[INSTALL.md](INSTALL.md)**.

Quick local start:

```bash
npm ci
npm run dev
```

Then open `http://127.0.0.1:4020`.

## Security

Please report security issues privately rather than opening a public issue. Never include capabilities, payment credentials, wallet material or production connection strings in a report.

## License

All rights reserved while the product and abuse model are being validated.
