# Voidly Pay — Settlement Invariants

> The nine-check rule. Every transfer settles iff *all* of these hold.
> Any check failing → `status='failed'` with the specific `reason` code
> below; the ledger row is still written (auditable). No exceptions, no
> short-circuits, no "but just this once."
>
> Money bugs are permanent. These invariants are the spec the code has
> to match.

## Amount unit

**Everything is micro-credits.** 1 credit = 1,000,000 micro. An
envelope with `amount_micro: 50000000` moves 50 credits. No floats
anywhere in the money path. The UI layer formats micro → display.

## The settlement rule

A `voidly-credit-transfer/v1` envelope settles iff all nine conditions
are true at the moment the settlement transaction commits.

### 1. Signature valid

- The envelope is canonicalized per RFC 8785-ish rules (keys sorted
  lexicographically, no whitespace, UTF-8 bytes).
- `sender_signature` is a 64-byte Ed25519 signature (base64-encoded
  in the wire format).
- The signature verifies against the sender's DID public key (the
  same key the agent relay uses for `did:voidly:*`).
- **Reason on fail**: `invalid_signature` (deliberately generic — no
  side-channel leak about which verification step tripped).

### 2. Envelope not expired

- `issued_at` ≤ `now` ≤ `expires_at`.
- `expires_at - issued_at` ≤ **60 minutes** (longer windows rejected
  outright — limits the replay window).
- `issued_at` ≤ `now + 30s` (tolerate small clock skew but reject
  far-future envelopes).
- **Reason on fail**: `envelope_expired` (if now > expires_at) or
  `envelope_not_yet_valid` (if now < issued_at - 30s) or
  `envelope_window_too_long` (if window > 60min).

### 3. Nonce unique per sender

- Enforced at the DB layer by `UNIQUE(from_did, nonce)`.
- Application does not check this — let the DB reject the insert.
  Prevents TOCTOU.
- **Reason on fail**: `nonce_seen` (caller should regenerate nonce
  and retry).

### 4. Sender wallet active

- A row for `from_did` exists in `agent_wallets`.
- `agent_wallets.frozen = 0`.
- `pay_system_state.system_frozen = 0`.
- `agent_wallets.balance_credits >= amount_micro`.
- **Reason on fail**: `sender_not_found` | `sender_frozen` |
  `system_frozen` | `insufficient_balance`. (Listed as distinct
  reasons because senders may act on them; distinguishing here is
  safe as long as the sender is the one asking.)

### 5. Daily cap not exceeded

- Sum of `amount_micro` across `status='settled'` rows with
  `from_did = <sender>` AND `settled_at >= now - 24h`, plus the
  current amount, ≤ `agent_wallets.daily_cap_credits`.
- Query uses a rolling 24h window, not a calendar-day boundary —
  avoids the "reset at midnight" attack.
- **Reason on fail**: `daily_cap_exceeded`.

### 6. Per-transaction cap not exceeded

- `amount_micro ≤ agent_wallets.per_tx_cap_credits`.
- **Reason on fail**: `per_tx_cap_exceeded`.

### 7. Recipient allowlist (if set)

- If `agent_wallets.allowlist_json` is non-null for the sender, it
  parses as JSON `{"recipients": [did, did, ...]}`.
- `to_did` must be in that list.
- If `allowlist_json` is null, no restriction (any recipient OK).
- **Reason on fail**: `recipient_not_allowed`.

### 8. Recipient wallet or auto-create

- If a row for `to_did` exists in `agent_wallets`, use it.
- If not and `to_did` matches the `did:voidly:*` format (agent-relay-
  registered DID): auto-create the wallet with default caps + zero
  balance. Write a `create_wallet` audit row with `actor='system:auto_create_on_receive'`.
- If `to_did` is malformed or not a Voidly DID format, reject.
- **Reason on fail**: `recipient_invalid_did`.

### 9. Amount bounds

- `amount_micro > 0` (strict — no zero-amount transfers; those make
  no sense and are a common bug vector).
- `amount_micro ≤ 10^15` (1 billion credits — sanity bound to reject
  overflow attacks even though SQLite INTEGER is 64-bit).
- **Reason on fail**: `amount_out_of_range`.

## Atomicity

All nine checks + the balance updates + the ledger-row insert run
inside a single `env.DB.batch([...])` transaction. D1 guarantees
all-or-nothing at the batch boundary. If any statement in the batch
fails, the whole transaction rolls back; no partial writes, no
dangling ledger rows with mismatched balances.

The only exception is the auto-create-on-receive wallet insert —
that's a separate batch that runs *before* the settlement batch, so
a wallet gets created even if the settlement later fails. This is
deliberate: the wallet represents the DID's intent to be a
participant, separate from any specific transfer.

## Replay prevention

Four layers:

1. DB-level `UNIQUE(from_did, nonce)` — no envelope settles twice.
2. Envelope `expires_at` window of max 60min — old envelopes can't
   be resurrected later.
3. Signature covers every field including `issued_at` + `nonce` —
   mutated envelope fails check 1.
4. `pay_system_state.system_frozen = 1` — global halt overrides
   everything.

## Failure modes catalogued

Every `reason` code a caller can see, in one place:

| reason | 9-check # | HTTP | Retryable? |
|---|---|---|---|
| `invalid_signature` | 1 | 400 | No — caller must re-sign |
| `envelope_expired` | 2 | 400 | No — caller must re-create with fresh issued_at |
| `envelope_not_yet_valid` | 2 | 400 | Wait then retry |
| `envelope_window_too_long` | 2 | 400 | Shorten window, re-sign |
| `nonce_seen` | 3 | 409 | Yes — regenerate nonce, re-sign, retry |
| `sender_not_found` | 4 | 404 | No — sender must `POST /v1/pay/wallet` first |
| `sender_frozen` | 4 | 403 | No — requires human unfreeze |
| `system_frozen` | 4 | 503 | No — system-wide halt in effect |
| `insufficient_balance` | 4 | 402 | After top-up |
| `daily_cap_exceeded` | 5 | 429 | After next 24h window rolls |
| `per_tx_cap_exceeded` | 6 | 400 | Split into smaller transfers |
| `recipient_not_allowed` | 7 | 403 | No — requires allowlist change |
| `recipient_invalid_did` | 8 | 400 | No — use valid `did:voidly:*` |
| `amount_out_of_range` | 9 | 400 | No — amount must be in (0, 10^15] |

## Test coverage required (matches tests/voidly_pay_*.test.ts)

Every invariant above needs at least one failing-case test. The
property-based test generates random envelope variants and asserts:

- Valid envelope → exactly one `status='settled'` row, balance delta
  is exact.
- Any one field mutated → `status='failed'` with the documented
  reason for that mutation class.
- Identical envelope submitted N times → exactly one settles
  (tested with N=1, N=10, N=100 concurrent).

## Why not fewer / more checks

- We could skip check 8 (auto-create) by requiring every recipient
  to have an explicit `POST /v1/pay/wallet` first. Rejected because
  it makes the developer experience brittle — agents would need to
  check "does this recipient have a wallet?" before every payment.
  Auto-create is cheap (one row) and safe (no balance changes).
- We could skip check 2 (window) — envelopes without expiry are
  simpler to generate. Rejected: replay-prevention degrades to
  "nonce uniqueness for all time" which means either the DB grows
  unbounded, or old envelopes get resurrected after cleanup.
- We don't have a "recipient frozen" check. Frozen wallets can
  still receive (by design — could be a refund). This is
  asymmetric and deliberate.

## Stage 2 hooks preserved

The settlement engine's input is an envelope + validated signature.
In Stage 2 when credits are backed by USDC on Base:

- Check 4's `balance_credits` query reads from an on-chain view
  contract instead of the local DB row.
- Check 5's daily-cap logic stays identical.
- The ledger row still gets written locally for audit.
- The settle step may need to call into an on-chain escrow contract
  (async) — but the invariant ordering and the 9-check rule remain
  unchanged.

The point: Stage 2 is a *backing swap*, not a protocol change. Same
envelope, same invariants, same reasons, same tests.
