# Voidly Pay — Work-Receipt Invariants (Stage 1.6)

Proof-of-work receipts add a co-signed handshake on top of escrow so
that agent-to-agent work can settle without a human in the loop.

This document is the normative spec. If the code disagrees with this
file, the code is wrong. The escrow and credit-transfer invariants
(see `voidly-pay-invariants.md` + `voidly-pay-escrow-invariants.md`)
still apply unchanged — receipts never bypass them.

## The object

A **work receipt** is a row in `pay_work_receipts` containing:

1. The provider's **claim envelope** (signed by `to_did`) — attests
   "I delivered work with sha256 = `work_hash`."
2. Optionally, the requester's **acceptance envelope** (signed by
   `from_did`) — attests "I accept the delivery," or "I dispute it."
3. Timestamps, state, and the auto-accept / auto-expire policy.

A receipt can stand alone (pure cryptographic evidence of delivery)
or link to a `pay_escrow_holds.id`. When linked, acceptance auto-
releases the escrow via the same settlement engine — the receipt is
the trigger, the escrow is the movement.

## State machine

```
(none)
  │
  │ provider signs + posts claim
  ▼
pending_acceptance ──── requester accept ────► accepted
  │                                             │
  │                                             │ (if escrow linked)
  │                                             ▼
  │                                         escrow released
  │
  │── requester dispute ──► disputed (escrow stays open)
  │
  │── deadline passes, auto_accept_on_timeout=true ──► accepted (actor=system:timeout)
  │
  │── deadline passes, auto_accept_on_timeout=false ──► expired
  │
  │── admin force-accept/dispute (future Stage 2) ──► accepted|disputed (actor=admin:<keyid>)
```

Terminal states (`accepted`, `disputed`, `expired`) never transition.
Every `UPDATE` in the engine carries `WHERE state = 'pending_acceptance'`
as a guard so concurrent accept + sweep races settle to exactly one
winner.

## The 12 checks (submitClaim)

Run in order; first failure aborts.

1. **System-frozen check.** `pay_system_state.system_frozen != 1`.
2. **Provider pubkey resolvable.** `to_did` is a registered Voidly agent.
3. **Claim signature verifies** against the provider's Ed25519 public
   key over the canonical JSON bytes of the envelope.
4. **Requester DID registered.** `from_did` is a registered Voidly
   agent (so they can sign acceptance later).
5. **Claim envelope window bounded.** `issued_at ≤ now ≤ expires_at`
   within clock-skew tolerance; `expires_at − issued_at ≤ 60 min`.
6. **Acceptance window bounded.** `MIN_ACCEPTANCE_WINDOW_MS ≤
   acceptance_deadline_at − issued_at ≤ MAX_ACCEPTANCE_WINDOW_MS`
   (5 min ≤ window ≤ 7 days).
7. **Work hash shape.** `work_hash` matches `/^[0-9a-f]{64}$/` after
   lowercasing.
8. **If linked to an escrow:** the escrow exists, `state = 'open'`,
   and `escrow.from_did == claim.from_did` AND `escrow.to_did ==
   claim.to_did`. This prevents a provider from minting a claim
   against someone else's escrow.
9. **If linked:** `acceptance_deadline_at ≤ escrow.deadline_at`. The
   acceptance window must fit inside the escrow's hold window.
10. **Nonce uniqueness per provider.** `UNIQUE(to_did, claim_nonce)`
    blocks replay.
11. **Summary / memo length limits** (≤ 280 chars) enforced by schema
    `CHECK` constraints — defense-in-depth beyond validator.
12. **Atomic insert.** The INSERT either succeeds and the receipt is
    `pending_acceptance`, or fails with `nonce_seen`. No partial
    state.

## The 6 checks (submitAcceptance)

1. **Receipt exists** with `state = 'pending_acceptance'`.
2. **Signer is the requester.** `envelope.signer_did == receipt.from_did`.
3. **Acceptance signature verifies** against the requester's public
   key.
4. **Acceptance envelope window bounded** (≤ 60 min).
5. **State-guarded UPDATE.** Transitions from `pending_acceptance` to
   `accepted` or `disputed` atomically; zero rows affected → `receipt_not_pending`.
6. **On accept with linked escrow:** attempt to release via a guarded
   atomic batch. Non-fatal — release failures record
   `escrow_release_error` but don't block the receipt transition. The
   co-signed evidence stands regardless.

## Sweep checks (auto-accept + auto-expire)

Cron-callable (and public — idempotent). For each `pending_acceptance`
receipt with `acceptance_deadline_at < now`:

- If `auto_accept_on_timeout = 1`: transition to `accepted` with
  `actor = 'system:timeout'`; if linked to an escrow, attempt release.
- If `auto_accept_on_timeout = 0`: transition to `expired`. Linked
  escrow stays open — recourse is the escrow's own deadline auto-
  refund or an admin force-refund.

Every transition is a state-guarded UPDATE; concurrent manual
accept + sweep settle to exactly one terminal state.

## Credit conservation invariant

For every receipt state transition:

- **pending_acceptance → accepted (linked, released):** credits move
  from `from_did.locked_credits` → `to_did.balance_credits`. Sum of
  `(balance + locked)` across all DIDs is unchanged.
- **pending_acceptance → accepted (linked, release fails):** no
  credit movement. `escrow_release_error` records why; credits stay
  locked; operator reconciles via admin tools.
- **pending_acceptance → accepted (standalone):** no credit movement.
- **pending_acceptance → disputed:** no credit movement.
- **pending_acceptance → expired:** no credit movement.

Receipts never create or destroy credits. They only **trigger** escrow
releases, which themselves preserve the conservation invariant (see
`voidly-pay-escrow-invariants.md`).

## What auto-accept guarantees

An accepted receipt where `actor = 'system:timeout'` proves:
1. The provider signed a claim binding `work_hash` + `task_id`.
2. The requester did not dispute within the acceptance window.
3. Time moved forward past the deadline.

It does NOT prove the work was good, only that the requester didn't
object. If you want stronger guarantees, set
`auto_accept_on_timeout = false` and require an explicit signed
acceptance.

Auto-accept is the default because agents go offline. A provider who
delivers + claims and then waits 48 hours should be paid unless the
requester objects; requiring a manual acceptance signature for every
transaction would break autonomy.

## Failure reasons

| Reason | HTTP | Action |
|---|---|---|
| `invalid_signature` | 400 | Re-sign with the right key |
| `envelope_expired` | 400 | Re-create with fresh `issued_at` |
| `envelope_window_too_long` | 400 | Shorten to ≤ 60 min |
| `nonce_seen` | 409 | Regenerate nonce, re-sign, retry |
| `provider_pubkey_not_found` | 404 | Register the provider DID first |
| `requester_pubkey_not_found` | 404 | Register the requester DID first |
| `receipt_not_found` | 404 | Wrong receipt_id |
| `receipt_not_pending` | 409 | Receipt already terminal |
| `receipt_signer_not_authorized` | 403 | Only the requester can accept/dispute |
| `escrow_not_found` | 404 | Linked escrow_id bad |
| `escrow_not_open` | 409 | Escrow already terminal when claim submitted |
| `escrow_did_mismatch` | 400 | Claim DIDs don't match escrow DIDs |
| `acceptance_deadline_exceeds_escrow` | 400 | Acceptance window longer than escrow hold |
| `invalid_work_hash` | 400 | Not 64-char lowercase hex sha256 |
| `acceptance_window_too_short` | 400 | < 5 min |
| `acceptance_window_too_long` | 400 | > 7 days |
| `acceptance_deadline_past` | 400 | Deadline in the past |
| `dispute_reason_required` | 400 | Dispute action missing `dispute_reason` |
| `system_frozen` | 503 | System-wide halt |

## Dispute path (Stage 2 expansion)

Today, a disputed receipt stops the auto-release. The linked escrow
stays open and the path forward is:
1. Parties resolve off-band, one signs manual release/refund.
2. Escrow deadline arrives, sweep auto-refunds.
3. Admin key force-releases or force-refunds with evidence.

Stage 2 adds structured dispute submission + evidence attachments +
arbitrator signatures. The on-disk format is forward-compatible —
today's disputed receipts carry the full claim + dispute envelope, so
a future arbitration tool can read them unchanged.

## What this is NOT

- **Not a marketplace.** There's no discovery, no pricing negotiation,
  no reputation system. Those compose on top.
- **Not a trust oracle.** Signed claims + acceptances are evidence,
  not truth. A lying provider with a complicit requester can
  collude on any work_hash. The evidence exists so a third party can
  verify later — it doesn't prevent fraud.
- **Not Stage 2.** Stage 1.6 runs on Voidly credits with no off-ramp.
  Stage 2 will back credits with USDC on Base; receipts then gate
  real-value settlement.

## Units + limits

| Constant | Value |
|---|---|
| `MIN_ACCEPTANCE_WINDOW_MS` | 5 minutes |
| `MAX_ACCEPTANCE_WINDOW_MS` | 7 days |
| `MAX_WINDOW_MS` (envelope) | 60 minutes |
| `MAX_CLOCK_SKEW_MS` | 30 seconds |
| `MAX_SUMMARY_LENGTH` | 280 chars |
| `MAX_TASK_ID_LENGTH` | 128 chars |
| `work_hash` format | 64-char lowercase hex sha256 |

## Files

| Path | Purpose |
|---|---|
| `worker/migrations/0028_work_receipts.sql` | Schema |
| `worker/src/routes/pay/envelope.ts` | `WORK_CLAIM_SCHEMA`, `WORK_ACCEPTANCE_SCHEMA` + validators |
| `worker/src/routes/pay/receipts.ts` | submitClaim, submitAcceptance, sweepReceipts |
| `worker/src/routes/pay/router.ts` | 6 receipt HTTP routes + manifest entries |
| `worker/tests/pay/receipts.test.ts` | 12-test suite |
| `mcp-server/src/index.ts` | 4 MCP tools — agent_work_claim, agent_work_accept, agent_work_dispute, agent_receipt_status |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/pay/receipt/claim` | provider signature | Provider submits signed delivery claim |
| POST | `/v1/pay/receipt/accept` | requester signature | Requester signs accept or dispute; on accept auto-releases linked escrow |
| GET | `/v1/pay/receipt/{id}` | none | Fetch a receipt |
| GET | `/v1/pay/receipt/escrow/{escrow_id}` | none | List receipts linked to an escrow |
| GET | `/v1/pay/receipt/did/{did}?role=from\|to\|any&limit=…` | none | List receipts for a DID |
| POST | `/v1/pay/receipt/sweep` | none (idempotent) | Auto-accept/expire past-deadline receipts |
