# GATE Lightning Address Beta Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build an agent-first, human-compatible, non-custodial HTTP 402 gateway whose merchants need only a Lightning Address and receive payments directly in their own wallets.

**Architecture:** Add a distinct `gate` bounded context rather than extending the current CATCH/WHISPER/PULSE payment-order model. A merchant project owns one Lightning Address, one or more fixed-price route policies, an administration bearer capability, a monthly allowance of 25 successful authorizations, and immutable prepaid authorization grants. GATE resolves LNURL-pay, validates the returned BOLT11, verifies settlement either from the payer preimage or optional LUD-21 `verify`, consumes one authorization credit atomically, and issues a short-lived signed receipt bound to project, route, HTTP method, path and request-body digest. GATE never receives, stores, forwards or withdraws merchant funds.

**Tech Stack:** TypeScript 6, Node 22, Fastify 5, PostgreSQL 17, Vitest, existing BOLT11/L402/Payment Authentication modules, static HTML/CSS/JS, OpenAPI 3.1 and Postman.

---

## Beta boundaries

- Mainnet Lightning Addresses only.
- Agent-first through L402 and HTTP Payment Authentication.
- Human checkout supported when WebLN returns a preimage or the LNURL invoice response includes LUD-21 `verify`.
- No QR/deep-link promise when neither proof path is available.
- No merchant wallets, balances, payouts, refunds, splits, fiat, subscriptions, reverse proxy or arbitrary origin forwarding.
- No real invoice in automated tests or visual verification.
- GATE is opt-in behind `GATE_ENABLED`; production activation is a separate release decision.

## Beta pricing

- 25 successful GATE authorizations per UTC calendar month are free per project.
- Prepaid authorization grants are service entitlements, not money: non-transferable, non-withdrawable, non-refundable after activation, and consumed only after verified payment authorization.
- Initial packs:
  - `spark`: 420 authorizations for 42 sats.
  - `standard`: 4,200 authorizations for 402 sats.
  - `long`: 42,000 authorizations for 4,002 sats.
- Consume monthly free allowance first, then prepaid grants ordered by earliest expiry/purchase. Initial beta grants expire 402 days after purchase.
- Pack purchase reuses the existing The402Machine LNbits checkout and provisions an authorization grant atomically after payment. Do not implement subscriptions.

## Task 1: Domain constants and validation

**Files:**
- Create: `src/gate/gate-domain.ts`
- Test: `test/gate/gate-domain.test.ts`

**TDD steps:**
1. Write failing tests for the three packs, 25 free monthly authorizations, 402-day grant expiry, Lightning Address normalization, fixed route-price range, allowed methods, and request-binding validation.
2. Run `npx vitest run test/gate/gate-domain.test.ts --maxWorkers=1` and observe expected missing-module failures.
3. Implement the smallest immutable constants and parsers.
4. Re-run the focused test and then existing domain tests.

## Task 2: LNURL-pay resolver and invoice adapter

**Files:**
- Create: `src/gate/lightning-address-adapter.ts`
- Test: `test/gate/lightning-address-adapter.test.ts`
- Reuse: `src/payment/bolt11-validation.ts`

**TDD steps:**
1. Write failing tests for LUD-16 resolution, HTTPS-only callbacks, exact min/max validation, exact millisat amount, metadata-hash validation through BOLT11, optional `verify`, callback/verify SSRF rejection, response-size/time limits, redirect rejection, invalid JSON and ambiguous provider failure.
2. Use injected `fetch`, DNS/address classifier and clock functions. Tests must not access the network.
3. Run focused tests and observe failure.
4. Implement a strict adapter that returns invoice, payment hash, expiry and either `verify-url` or `payer-preimage` verification mode.
5. Re-run focused tests.

## Task 3: Forward-only PostgreSQL schema

**Files:**
- Create: `migrations/0020_gate.sql`
- Modify: `test/storage/migration.test.ts`

**Schema:**
- `gate_projects`: project id, display name, normalized Lightning Address, hashed admin token, monthly free limit, active state and timestamps.
- `gate_routes`: immutable route key, method, path template/exact path, price sats, active state and unique project/route key.
- `gate_intents`: project, route, idempotency key, canonical binding fields, amount, invoice/payment hash, verify URL, state, expiry, authorization timestamp and unique payment hash.
- `gate_credit_grants`: project, source pack/order, total, remaining, expiry and timestamps.
- `gate_authorizations`: intent, unique receipt id/JTI, source (`monthly_free` or grant), source month/grant, consumed timestamp and timestamps.
- Database checks for valid state transitions, non-negative counts, exact payment-hash shape, bounded paths and no reusable payment hash.

**TDD steps:**
1. Add migration tests first and observe failure.
2. Add migration and marker.
3. Verify clean bootstrap, reapplication, constraints and historical migrations remain immutable.

## Task 4: Repository and atomic quota consumption

**Files:**
- Create: `src/gate/gate-repository.ts`
- Test: `test/gate/gate-repository.test.ts`

**TDD behaviors:**
- Stable project/route creation and token hashing.
- `project + idempotency_key` returns one intent only when binding fields match; mismatch fails.
- Persist intent before invoice attachment.
- Attach one invoice/payment hash exactly once.
- A verified intent atomically consumes monthly free allowance first, then earliest valid prepaid grant.
- 26th monthly authorization without credits fails without issuing a receipt.
- Concurrent verification consumes one credit and one JTI.
- Replay returns the existing receipt only for the same exact request if beta policy allows safe retry; it never consumes a second credit.
- Expired invoice or exhausted credits fail closed.

## Task 5: Receipt signing and verification

**Files:**
- Create: `src/gate/gate-receipt.ts`
- Test: `test/gate/gate-receipt.test.ts`

**Contract:**
- Ed25519-signed compact JWS or equivalent, separate GATE key.
- Claims: issuer, audience/project, route id, method, canonical path, body SHA-256, amount sats, payment hash, JTI, issued-at and short expiry.
- Publish public verification key/JWKS without exposing private material.
- Test wrong project, method, path, body, expiry, signature and replay identifier.

## Task 6: GATE service state machine

**Files:**
- Create: `src/gate/gate-service.ts`
- Test: `test/gate/gate-service.test.ts`

**TDD behaviors:**
- Quote creates/persists intent, then requests one LNURL invoice.
- Ambiguous invoice creation becomes `invoice_uncertain` and is never retried automatically.
- Preimage verification checks SHA-256 against payment hash.
- LUD-21 polling verifies returned invoice identity and settlement server-side.
- Callback/polling is only a signal, never authority without adapter validation.
- Successful verification atomically consumes a GATE authorization and returns a signed receipt.
- No credit is consumed for unpaid, invalid, expired or replayed attempts.

## Task 7: Public and administrative API

**Files:**
- Create: `src/gate/gate-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/server.ts`
- Modify: `src/config.ts`
- Test: `test/gate/gate-api.test.ts`
- Test: `test/config.test.ts`

**Beta endpoints:**
- `POST /api/gate/projects` behind a beta provisioning/admin secret, returns project admin capability once.
- `GET /api/gate/projects/:projectId` with project admin bearer token.
- `POST /api/gate/projects/:projectId/routes` with project admin token.
- `GET /api/gate/projects/:projectId/routes` with project admin token.
- `POST /api/gate/intents` authenticated by project API capability and `Idempotency-Key`.
- `GET /api/gate/intents/:intentId` for bounded settlement polling.
- `POST /api/gate/intents/:intentId/prove` with payer preimage.
- `POST /api/gate/receipts/verify` for middleware/local integration checks.
- `GET /.well-known/jwks.json` for receipt verification.
- Pack purchase endpoints added only after Task 9 provisions credits through existing checkout.

**Controls:**
- Separate quote/poll/admin/proof rate limits.
- `Cache-Control: no-store` on private/payment responses.
- Exact body parsing under the composed Fastify app.
- Feature routes absent unless `GATE_ENABLED=true` and required keys/database are valid.

## Task 8: Agent protocols and exact request binding

**Files:**
- Create: `src/gate/gate-payment-protocol.ts` or generalize existing helpers without weakening existing product tests.
- Test: `test/gate/gate-payment-protocol.test.ts`
- Test: `test/gate/gate-api.test.ts`

**TDD behaviors:**
- GATE emits native JSON 402, HTTP Payment Authentication and canonical L402 challenges.
- Credentials bind project, route, method, canonical path and exact body bytes.
- A credential for one merchant or route never authorizes another.
- A payment hash authorizes at most one GATE intent.
- Safe retry returns the same authorization result without consuming another usage.

## Task 9: Prepaid pack checkout

**Files:**
- Modify: `src/payment/payment-domain.ts`
- Modify or extend: `src/payment/payment-service.ts`
- Modify: `src/payment/payment-repository.ts`
- Add forward migration if the existing product enum/order constraints need a `gate` product or create a separate pack-order table if that preserves cleaner boundaries.
- Tests: domain, repository, service, API and migration focused on pack identity and atomic credit provisioning.

**Decision rule:** Prefer a separate `gate_pack_orders` table if extending `payment_product` would force GATE credits into disposable-resource assumptions. Reuse the LNbits adapter and idempotent invoice lifecycle, not necessarily the existing resource table.

**TDD behaviors:**
- Pack prices and counts exactly match beta catalogue.
- Payment creates one grant once.
- Retry after settlement returns the same grant and never adds credits twice.
- Pack credit is non-transferable and tied to one project.
- No real invoice in tests.

## Task 10: SDK/middleware

**Files:**
- Create: `sdk/node/package.json`
- Create: `sdk/node/src/index.ts`
- Create: `sdk/node/test/middleware.test.ts`
- Document local build/test commands.

**Beta API:**
- `createGateMiddleware({ projectId, projectKey, gateBaseUrl, receiptPublicKey })`.
- Fastify/Express-compatible request helper or framework-neutral `authorize(request)` first if dual-framework middleware creates unnecessary scope.
- It forwards only canonical method/path/body digest and returns the GATE 402 response unchanged.
- It validates a successful receipt locally and strips client-supplied GATE identity headers.
- No arbitrary origin proxying.

## Task 11: Human beta surface

**Files:**
- Create: `public/gate.html`
- Create: `public/assets/gate.js`
- Modify: `public/assets/styles.css`
- Modify: `public/index.html`
- Modify public footer/navigation pages only where needed.
- Test: `test/gate/gate-browser.test.ts`
- Test: `test/landing.test.ts`

**UX:**
- Agent-first explanation with a compact human fallback section.
- Show “All you need is a Lightning Address”.
- Explain preimage/WebLN and optional automatic QR settlement honestly.
- Display 25 free authorizations/month and prepaid packs.
- No signup/payment side effects while browsing.
- Beta onboarding form may remain invite/admin-secret based; do not invent conventional accounts.

## Task 12: OpenAPI, Postman and agent docs

**Files:**
- Modify: `public/openapi.json`
- Modify: `public/postman.json`
- Modify: `public/api.html`
- Modify: `public/agents.html`
- Modify: `README.md`
- Modify: `test/api-docs.test.ts`

**Contract requirements:**
- Distinguish HTTP 402, Payment Authentication, L402 and x402 explicitly.
- No claim of x402 compatibility.
- Include concrete request/response schemas, security schemes, idempotency and exact-byte retry examples.
- Postman uses stable synthetic idempotency variables and no secrets/invoices/preimages.
- Internal beta provisioning endpoints excluded from public contracts unless intentionally documented for invite users.

## Task 13: Full verification and review

Run:
- Focused GATE tests during each RED/GREEN loop.
- `npm run test -- --maxWorkers=1`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- SDK tests/build.
- `npm audit --omit=dev --audit-level=high`
- `docker compose --env-file .env.example config --quiet`
- OpenAPI and Postman schema/lint gates.
- `git diff --check`
- Secret/payment-request scan.
- Browser review of `/gate`, `/api`, `/agents` on desktop and mobile.
- Independent spec review, then security/code-quality review against exact HEAD.

## Task 14: Release boundary

- Do not enable GATE in production merely because code is complete.
- Commit/push only after all gates and reviews pass.
- Production activation requires an explicit deployment decision, generated GATE signing/admin keys, migration, feature flag, and non-financial smoke tests.
- Do not create or pay a real invoice without separate explicit authorization.
- Verify production commit, migration marker, routes, JWKS, health and logs after any later deployment.
