# Voidly Pay Escrow — Invariants

> Escrow is Pay with a state machine. Same canonical envelope, same
> Ed25519 signing, same settlement safety rails — plus four states
> and a deadline. These invariants extend the 9-check rule in
> [`voidly-pay-invariants.md`](./voidly-pay-invariants.md). When the
> two docs conflict, the Pay invariants win and this doc gets updated.

## Why escrow

Plain Pay is fire-and-forget: A sends credits to B, done. That works
for tipping and for after-the-fact settlement, but it doesn't let A
hire B — because A has no recourse if B doesn't deliver.

Escrow adds a hold: A locks credits that B can claim only after (or
only if) conditions are met. Until then, the credits aren't in B's
balance (B can't spend them) but also aren't in A's spendable balance
(A can't double-spend them). This is how two agents contract.

## Credit conservation (the top-level invariant)

For every DID, at every moment:

```
owned = balance_credits + locked_credits
```

Escrow operations move credits between `balance_credits` and
`locked_credits` on one or two wallets. No operation creates or
destroys credits. The sum of `owned` across all wallets is
conserved end-to-end.

Test: the property-based escrow test runs 10,000 random open/
release/refund/expire sequences and asserts `sum(balance_credits) +
sum(locked_credits)` is constant.

## State machine

```
                        ┌──────────────┐
                        │   (doesn't   │
                        │    exist)    │
                        └──────┬───────┘
                               │ open (sender-signed)
                               ▼
                        ┌──────────────┐
             expire ───▶│     open     │──release (signed)
                        └──────┬───────┘            │
                               │ refund             │
                               ▼                    ▼
                        ┌──────────────┐    ┌──────────────┐
                        │   refunded   │    │   released   │
                        └──────────────┘    └──────────────┘
                        ┌──────────────┐
                        │   expired    │    (auto-refund semantics;
                        └──────────────┘     logged as its own terminal
                                             state for audit clarity)
```

Four states. Three terminal (released, refunded, expired). One active
(open). No state can transition to itself or to a terminal from a
terminal.

## The 12-check rule (on top of Pay's 9)

An `open` operation settles iff all of:

1. **Sender envelope signature valid** (same as Pay #1, 2, 9).
2. **Escrow nonce unique per sender** (DB UNIQUE, same as Pay #3).
3. **Sender wallet exists, not frozen, not system-frozen** (Pay #4).
4. **Sender has `balance_credits >= amount`** (Pay #4).
5. **Sender's per-tx cap not exceeded** (Pay #6).
6. **Sender's daily cap not exceeded** — includes both plain
   transfers AND escrow opens in the rolling 24h. Rationale: an
   escrow is still "money leaving the sender's spendable balance,"
   so it should be capped the same way.
7. **Recipient is a valid + registered DID** (Pay #7, 8).
8. **Deadline is in the future AND `≤ 7 days` from now.** We
   deliberately cap the maximum hold duration at a week — long-
   dated escrows accumulate stale state and give Voidly custodial
   risk. Longer contracts can be re-opened weekly if needed.
9. **Escrow amount bounds** — `0 < amount_micro ≤ 10^15` (Pay #9).

A `release` operation settles iff:

10. **Release signer is one of:** the sender (unilateral release —
    "I'm happy, pay him"), OR an admin with `role in ('all','freeze')`
    (dispute resolution — operator confirms delivery).
11. **Escrow state = 'open'.** Cannot release an already-released,
    refunded, or expired escrow. DB-level optimistic-lock via the
    `UPDATE ... WHERE state='open'` pattern.

A `refund` operation settles iff:

12. **Refund signer is one of:** the sender (before deadline —
    "I changed my mind" / "B didn't deliver"), OR an admin (dispute
    resolution — operator rules in sender's favor).

`expire` is system-triggered: any `open` escrow whose `deadline_at
< now` auto-refunds to the sender on the next settlement attempt or
on a scheduled cron sweep.

## Signing payloads

Three envelope types, all canonically serialized + Ed25519 signed:

```
voidly-escrow-open/v1
  { schema, from_did, to_did, amount_micro, nonce,
    issued_at, expires_at, deadline_at, memo? }

voidly-escrow-release/v1
  { schema, escrow_id, signer_did, issued_at, expires_at, action_nonce }

voidly-escrow-refund/v1
  { schema, escrow_id, signer_did, reason?, issued_at, expires_at, action_nonce }
```

- Release + refund envelopes are small — they identify which escrow
  to operate on and who's authorizing. No amount is repeated on
  release/refund; the original `open` envelope's amount is
  authoritative.
- `signer_did` MUST match either the original `from_did` (sender
  self-service) or resolve to an admin via the admin signature path
  (dispute). Admin-signed releases/refunds use the same `keyid +
  signature_base64 + body` structure as the existing
  `/v1/pay/admin/*` endpoints.

## Failure reasons (add-ons to Pay's table)

| reason | HTTP | Retryable? |
|---|---|---|
| `escrow_not_found` | 404 | No |
| `escrow_not_open` | 409 | No — already terminal |
| `escrow_deadline_exceeds_max` | 400 | Shorten and retry |
| `escrow_deadline_past` | 400 | Re-open with a future deadline |
| `escrow_signer_not_authorized` | 403 | Signer is not sender or admin |
| `escrow_window_too_long` | 400 | Envelope expires_at too far out |

Plus every reason from the Pay 9-check rule applies to `open`.

## Auto-expire semantics

Escrows past their `deadline_at` with state='open' become stale.
Two paths resolve them:

1. **On-demand**: any settlement attempt (`release` or `refund`)
   against a stale escrow fails with `escrow_not_open` and a
   background sweep triggers on that escrow.
2. **Scheduled**: a cron fires every 5 minutes and:
   - Finds `state='open' AND deadline_at < now`.
   - For each: atomically move `amount_micro` from sender's
     `locked_credits` back to `balance_credits`, set state='expired'.

The UNIQUE constraint prevents double-expiry. The UPDATE ... WHERE
state='open' optimistic-lock prevents racing release + expire.

## What this does NOT do (by design)

- **No multi-sig release.** Release is either self-service (sender
  releases) or admin-arbitrated (dispute). For multi-party
  conditions, agents compose by opening multiple escrows in series.
- **No partial release.** All-or-nothing on the `amount_micro`. Splits
  are done client-side by opening N smaller escrows.
- **No milestones.** Milestones are N serial escrows; the `metadata`
  field is intentionally plaintext-only so no trust is placed on it.
- **No fee.** Voidly takes no cut of escrow in Stage 1. The fee
  model — if any — is a Stage 2 concern with multisig governance.

## Schema snapshot

```sql
pay_escrow_holds(
  id, nonce, from_did, to_did, amount_micro, memo,
  state CHECK IN ('open','released','refunded','expired'),
  reason, open_signature, open_envelope_hash,
  release_signature, refund_signature, refund_actor,
  issued_at, expires_at, deadline_at,
  opened_at, released_at, refunded_at,
  schema_version = 1,
  UNIQUE(from_did, nonce)
)
```

Indexes: `(from_did, opened_at DESC)`, `(to_did, opened_at DESC)`,
`(state, deadline_at)`, and a partial index
`WHERE state = 'open'` on `deadline_at` for the expire sweep.

## Test coverage required

Every state transition needs at least one passing test:

- **Valid open** → locked balance increments, escrow row state=open.
- **Duplicate nonce** → second open fails `nonce_seen`.
- **Release by sender** → recipient balance grows, sender locked
  decrements, state=released.
- **Release by admin (dispute)** → same economic effect; `refund_actor`
  reflects the keyid.
- **Double release** → second release fails `escrow_not_open`.
- **Refund by sender** → sender balance restored, state=refunded.
- **Expired escrow (time travel)** → simulate `deadline_at < now`,
  observe auto-refund via sweep function.
- **Admin refund (dispute)** → sender balance restored, state=refunded,
  `refund_actor='admin:<keyid>'`.
- **Credit conservation** — 10k random-sequence property test: for
  every sequence of opens/releases/refunds/expirations, the total
  `balance_credits + locked_credits` across all wallets is invariant.
