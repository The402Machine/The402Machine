# Payment protocol compatibility

The402Machine exposes one product and provisioning system through three additive payment flows.

| Flow | Challenge | Proof | Intended clients | Status |
| --- | --- | --- | --- | --- |
| Native | HTTP 402 JSON quote | Server-side LNbits settlement polling | Browser checkout, simple scripts | Stable |
| HTTP Payment Authentication | `WWW-Authenticate: Payment` | Lightning BOLT11 preimage in `Authorization: Payment` | Agents and interoperable HTTP clients | Implemented against the current Internet-Draft |
| L402 | `WWW-Authenticate: L402` | Request-bound binary macaroon plus BOLT11 preimage | Existing Lightning and LSAT/L402 clients | Compatibility adapter |
| Coinbase x402 | x402 payment requirements and settlement contracts | Network-specific | x402 clients | Not implemented |

## Shared properties

- Invoice rail: BOLT11 through the configured invoice-only LNbits wallet.
- Currency: satoshis.
- Provisioning: the existing transactional CATCH, WHISPER or PULSE path.
- Idempotency: the same `Idempotency-Key` identifies the same intended purchase.
- Binding: product, plan, HTTP method, route, the exact request-body bytes and expiry are bound to the agent credential. JSON retries must preserve whitespace and key order as well as values.
- Invoice integrity: the server decodes BOLT11 before issuing a challenge and verifies its payment hash, satoshi amount, network and expiry.
- Verification: the preimage must hash to the invoice payment hash; the backend also verifies settlement and amount before provisioning.
- Replay protection: successful agent credentials are atomically consumed with provisioning in the payment challenge ledger. A concurrent or later replay is rejected.
- Delivery: product capabilities appear only after successful atomic provisioning.
- Privacy: preimages, macaroons, invoices and capabilities must not enter URLs, logs, analytics, telemetry or shared client environments.

## HTTP Payment Authentication

Send the ordinary purchase request with `X-Payment-Protocol: payment`. The server answers with HTTP 402 and a `WWW-Authenticate: Payment` challenge using `method="lightning"` and `intent="charge"`. Pay the embedded BOLT11 invoice and repeat the byte-identical request body with `Authorization: Payment <credential>`.

A successful response includes `Payment-Receipt`. The receipt contains the payment hash as a public reference, never the preimage.

This follows an active Internet-Draft. Its wire contract may evolve before becoming an RFC, so the API advertises it explicitly instead of treating every generic HTTP 402 response as Payment Authentication.

## L402 compatibility

Send `X-Payment-Protocol: l402`. The server answers with:

```http
WWW-Authenticate: L402 macaroon="<macaroon>", invoice="<bolt11>"
```

After payment, repeat the request with the exact same body bytes, including JSON whitespace and key order:

```http
Authorization: L402 <macaroon>:<preimage>
```

The binary version 2 macaroon identifier uses L402 version 0 semantics and commits to the invoice payment hash. First-party caveats restrict it to The402Machine provisioning, product, plan, method, route, body digest and validity window.

## Self-hosting and custody

Neither agent adapter requires an external custodian, hosted facilitator or proprietary settlement service. The operator can keep LNbits and LND self-hosted. `PAYMENT_PROTOCOL_KEY` is a separate non-financial secret used for HTTP challenge binding and L402 macaroon signing. It cannot spend sats, but disclosure could forge credentials.

See [`INSTALL.md`](INSTALL.md) for configuration and [`examples/agent-payment-client.mjs`](examples/agent-payment-client.mjs) for a dependency-free client example.
