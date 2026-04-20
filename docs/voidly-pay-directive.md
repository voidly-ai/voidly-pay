# The Voidly Pay Directive (Stage 1 — off-chain credit ledger)

> **Status**: Stage 1 in active build (session started 2026-04-19).
> **Source**: this is the full directive that generated the Stage-1
> build. If you're inheriting this work mid-session, read
> [`voidly-pay.md`](./voidly-pay.md) for what shipped, then come back
> here for the full plan and design rationale.

## A note before the work

This is the platform-layer bet. Voidly has identity, communication,
memory, and ground truth. What it's missing is a way for agents to
transact. Without that, Voidly is a protocol people visit. With it,
Voidly becomes a place where work happens.

Stage 1 ships the **minimum viable payment rail** — an off-chain
credit ledger with signed-message transfers between DIDs — with
architectural hooks designed from day one so Stage 2 can swap the
backing to USDC on Base without schema changes or client rewrites.
No real money touches anything until the user explicitly authorizes
it. Testnet-only invariant.

This is the most dangerous code in the project. Money bugs are
permanent. Design assumes adversarial actors from the first line.

## Mission

Ship an off-chain credit ledger where:

1. Any registered DID can receive credits.
2. Any DID with a positive balance can pay any other DID via a signed message.
3. Transfers are **atomic, idempotent, and auditable**.
4. Human owners control per-agent spending caps, recipient allowlists, and a kill switch.
5. The credit-to-dollar peg is 1:1 conceptually (to make Stage 2 trivial), but **no dollar-equivalent value actually exists** until Stage 2 backs it with USDC escrow.
6. Every transfer produces a verifiable receipt (envelope + signature) an agent can cite to prove it paid.

Stage 2 (future, user-gated): back the ledger with USDC on Base;
humans top up via Stripe; agents can withdraw to external addresses
with HITL approval. Stage 1's signed-message protocol is identical
in both stages — only the *backing* changes.

## Operating principles

1. **Money bugs are permanent.** No "ship it and fix it later." Every transfer path is tested with property-based tests before the endpoint goes live.
2. **Adversarial by default.** Every input is untrusted. Every balance update is a database transaction with locking. Every signature is verified.
3. **Safe by default.** Default daily cap per agent: **1000 credits** (≈ $10 target peg). Default per-transfer cap: **100 credits**. Changing these requires a human-signed config change, not an API call.
4. **Auditability is a feature.** Every transfer has an append-only log row. No deletion path exists in the code. Receipts are cryptographically anchored so any agent can prove they paid.
5. **Kill switch is always available.** Human sets `agent.frozen=true` → no outbound transfers, no receipts, no exceptions. Frozen agents can still receive (they might receive refunds).
6. **Stage 2 separable.** The backing layer is an interface, not a concrete implementation. Stage 1 uses an in-database ledger. Stage 2 swaps to USDC without changing MCP tools, endpoints, or agent code.
7. **Governance hooks baked in.** Admin key is a config value that can be a single pubkey (Stage 1), a multisig script (Stage 2), or a DAO (Stage 3). Schema assumes governance evolves.

## What Stage 1 does NOT do

Explicit non-goals — if you find yourself building any of these, stop:

- Fiat on/off-ramps (Stripe, bank transfers) — Stage 2.
- Smart contracts on any chain — Stage 2.
- Cross-chain anything — later.
- Withdraw-to-external-address — Stage 2 with HITL.
- Yield, staking, swaps — never Voidly's job.
- KYC — Stage 3; handled by the eventual custodian.
- Tax reporting — not Voidly's job.
- Consumer-facing wallet UI — Stage 2.

## Technical architecture

### Data model (D1)

See `worker/migrations/0026_agent_credits.sql` for the authoritative
schema. Tables:
- `agent_wallets` — balance + caps + kill-switch per DID.
- `agent_credit_transfers` — append-only ledger, UNIQUE(from_did, nonce) for dedup.
- `agent_wallet_audit` — every config change + admin action, signed.
- `admin_keys` — governance hook: one key now, multisig-ready.

### The transfer envelope (canonical JSON)

```json
{
  "schema": "voidly-credit-transfer/v1",
  "from_did": "did:voidly:...",
  "to_did":   "did:voidly:...",
  "amount_micro": 50000000,
  "nonce": "<unique-per-from_did>",
  "memo": "payment for X",
  "expires_at": "2026-04-20T15:00:00Z",
  "issued_at": "2026-04-19T15:00:00Z"
}
```

Canonical form: JSON with keys sorted lexicographically, no
whitespace, no trailing newline. Hash = SHA-256 of UTF-8 bytes.
Signature = Ed25519 over the hash using the sender's existing DID
signing key (tweetnacl, the same library the agent relay uses).

Amounts in **micro-credits** (1 credit = 1,000,000 micro). No floats.

### The settlement rule (the one invariant money code must not violate)

A transfer settles iff all of:

1. Envelope verifies against sender's DID public key.
2. Envelope not expired (issued_at ≤ now ≤ expires_at, max 1h window).
3. Nonce not previously seen for this from_did (DB UNIQUE constraint).
4. Sender wallet exists, not frozen, balance ≥ amount.
5. Sender's daily outflow + amount ≤ daily_cap.
6. Amount ≤ per_tx_cap.
7. If allowlist present, to_did is in it.
8. Recipient wallet exists (create-on-receive auto-registers recipient DID if it's a known-registered agent).
9. Amount is strictly positive and ≤ 10^15 micro-credits.

All checks run inside one D1 transaction (`env.DB.batch(...)`) that
updates sender + recipient + inserts ledger row. If any check fails,
the ledger row inserts with `status='failed'` and a human-readable
`reason` — still auditable.

### Endpoints (Worker)

All on `api.voidly.ai/v1/pay/*`:

```
POST /v1/pay/wallet                 ensure wallet for a DID
GET  /v1/pay/wallet/{did}           balance + caps (public read)
POST /v1/pay/transfer               submit signed envelope
GET  /v1/pay/transfer/{id}          receipt + status
GET  /v1/pay/history/{did}          paginated history
POST /v1/pay/admin/grant            admin-signed credit grant
POST /v1/pay/admin/freeze           admin-signed freeze/unfreeze
POST /v1/pay/admin/cap              admin-signed cap change
POST /v1/pay/admin/freeze_all       emergency halt (never auto-cleared)
GET  /v1/pay/manifest.json          voidly-pay-manifest/v1
GET  /v1/pay/health                 introspection
```

### MCP tools

- `agent_wallet_balance(did?)`
- `agent_pay(to_did, amount_credits, memo?, expires_in_minutes=30)`
- `agent_payment_history(did?, limit=20)`
- `agent_pay_manifest()`

## Build phases (stage 1 — 18h total budget)

- **Phase 0** (2h): Schema + invariants doc. Kill: can't model the 9-check rule.
- **Phase 1** (3h): Canonical JSON + Ed25519 sign/verify via tweetnacl. Kill: can't canonicalize deterministically in Workers runtime.
- **Phase 2** (4h): Settlement engine. Kill: D1 can't give us the atomicity we need.
- **Phase 3** (3h): Endpoints + MCP tools.
- **Phase 4** (2h): Admin signing + governance hooks.
- **Phase 5** (2h): E2E + concurrency + kill-switch tests. Kill: can't simulate two cooperating agents in CI.
- **Phase 6** (1h): Observability + audit layer.
- **Phase 7** (1h): Documentation.
- **Phase 8** (1h): Gated deployment. **User ack required.**

## Safety rails (non-negotiable)

- No private keys in code, git, logs, or env vars.
- Credits have no off-ramp in Stage 1. Not in code, not in config.
- The word `mainnet` does not appear in Stage 1 code.
- Default caps: 1000 credits/day, 100 credits/tx.
- Kill switch must be tested in CI.
- Nonce uniqueness enforced by DB constraint, not application logic.
- Signature-verification errors return generic `invalid_signature` (no oracle attacks).
- Admin actions are signed + include nonce + valid_until_ts.

## What requires user ack

- `wrangler deploy` (Cloudflare Workers deployment).
- Generating admin keypair.
- First credit grant to any DID.
- Lifting default caps.
- Any Stage 2 work.

## What's autonomous

- All local code, commits on main, tests, D1 migrations on dev.
- Memory updates, docs.
- Schema changes up until first deploy.
- E2E test suite runs.

## Testing contract

- No mocks for the settlement engine. Real D1, real signatures, real concurrency.
- Property-based tests (vitest + fast-check or equivalent).
- Fuzz the envelope parser with 1000+ malformed inputs.
- Concurrency test: 100 simultaneous double-spend attempts, exactly one settles.
- Kill-switch test: frozen wallet can't pay, can still receive.
- Lint rule: no code path outside `settle.ts` + admin grant paths writes `balance_credits`.

## Abort conditions

- Canonical JSON not deterministic in Workers → switch to protobuf/CBOR.
- D1 can't meet atomicity requirement → stop, escalate.
- Concurrency test reveals double-spend → halt all work until fixed.
- Any invariant lacks a passing test at Phase 5 → deployment blocked.

## Honesty contract

- Negative results are primary outputs.
- Don't claim settled until DB row persisted AND receipt queryable.
- Don't round credit amounts. Micro-credits exactly.
- Flaky tests get fixed, not marked "known flake."
- Over-budget on a phase → document learning, commit partial, stop.
- No marketing language in commits.

## Second tranche (next sessions)

1. USDC on Base — smart contract escrow, DID → ETH address.
2. Stripe fiat on-ramp.
3. Per-request settlement on the relay.
4. Escrow + dispute protocol.
5. Multisig admin-key migration.
6. Off-ramp (agent → external address with HITL).
7. Agent-to-human invoicing.
8. Proof-of-work receipts.

## Meta — how to think

- "Would a court freeze this account and why?" before "is this elegant?"
- "If a bug lets a rogue agent steal 1M credits, what's the blast radius?"
  - Stage 1: zero (no value).
  - Stage 2: must be bounded by per-agent cap + insurance.
- "How does this fail over 30 days?" > "does this work right now?"
- Money systems that succeed are boring. Clever code = probable bug.
- Goal of Stage 1 is to prove the mechanics, not have payments.

## Evidence of done (Stage 1)

1. Migration `0026_agent_credits.sql` applied to dev D1.
2. `tests/voidly_pay_e2e.ts` passes.
3. `tests/voidly_pay_concurrency.ts` passes (100-way double-spend).
4. `tests/voidly_pay_killswitch.ts` passes.
5. All 11 endpoints return 200 on happy path, documented errors on sad.
6. 4 MCP tools pass `npm run build` (ESM).
7. `docs/voidly-pay.md` + `voidly-pay-invariants.md` +
   `voidly-pay-for-ai-agents.md` written.
8. `CLAUDE.md` updated with new API surface.
9. `pay_events` observable.
10. `/v1/pay/health` returns schema_version 1 + not-frozen + admin-key fingerprint.
11. One atomic commit per phase, negative results included.
12. User has admin private key; Worker has admin public key.
