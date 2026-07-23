# The402Machine

> **Insert sats. Receive a tiny piece of the Internet. Use it. Watch it disappear.**

The402Machine is an open-source vending machine for temporary Internet appliances paid with Bitcoin over Lightning. No account, subscription, credit balance, or custodial payment processor.

## First cartridges

### CATCH

A private, inbound-only webhook inbox with hard request, storage, and lifetime limits.

- **Spark:** 4 hours 2 minutes.
- **Standard:** 4 weeks 2 days.
- **Long:** 4 months 2 days.

CATCH accepts bounded POST requests and never forwards, executes, or calls back into user-provided destinations.

### BURN

An encrypted note that disappears after its first successful read or when its selected lifetime ends.

## Product boundary

The402Machine sells closed functions, never general computing capability. It will not offer arbitrary code, proxies, redirects, tunnels, mutable public APIs, configurable HTTP responses, or user-controlled outbound requests.

## Current status

The public landing page and API health check are under active development. Payment and disposable-resource endpoints will be released only after their abuse controls and lifecycle guarantees are tested.

## Local development

Requirements:

- Node.js 22
- npm

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

Copy `.env.example` to `.env` for local development. Never commit payment credentials, wallet material, private keys, macaroons, or deployment secrets.

## Security

Please report security issues privately rather than opening a public issue. A dedicated security contact and disclosure policy will be published before payments are enabled.

## License

All rights reserved while the product and abuse model are being validated.
