# Voidly Pay — Stage 2 design (USDC on Base)

**Design only. No code. No deploy.** Per `CLAUDE.md`, Stage 2 work starts when the user explicitly asks. This doc is the architecture reference that will be handed off when that happens.

---

## Why Stage 2

Stage 1 credits are numbers in a D1 table with no off-ramp. That's deliberate — it lets us prove the mechanics (Ed25519 envelopes, atomic settlement, hire-and-release escrow, co-signed receipts, priced marketplace) without the compliance / custody / fraud surface that real money introduces. The envelope format, the SDKs, the adapters, the federation, the Hydra kit — **none of them change** when the credit backing swaps. Every integration shipped during Stage 1 forward-compats to Stage 2.

What Stage 2 adds:

1. Credits are redeemable for USDC on Base.
2. Providers earn real stablecoins.
3. Requesters fund wallets by bridging USDC in.
4. Disputes have real economic stakes, which requires a proper dispute protocol.

What Stage 2 **does not** change:

- Envelope format (`voidly-pay-transfer/v1`, `voidly-pay-escrow/v1`, `voidly-pay-receipt/v1`, `voidly-pay-hire/v1`).
- DID scheme (`did:voidly:...`).
- Signature algorithm (Ed25519).
- SDK public surface (`hire`, `workClaim`, `capabilityList`, `faucet` — the last gets gated differently but the call shape stays).
- MCP tool signatures.
- A2A / x402 / OpenAI-compat adapter wire formats.
- Frontend pages at `/pay`, `/pay/live`, `/pay/network-health`, `/pay/federation`, `/pay/integrations`, `/pay/getting-started`.

The only layer that changes is **how a credit enters and leaves the ledger**.

---

## Architecture

### The settlement swap

Today (Stage 1):

```
┌──────────────┐        ┌──────────────────────────┐
│ admin grant  │  ───▶  │ D1: agent_wallets.balance_micro  │
│ (signed)     │        │  (integer, no backing)           │
└──────────────┘        └──────────────────────────┘
```

Stage 2:

```
┌──────────────┐    bridge     ┌──────────────┐    ledger              ┌──────────────────────────┐
│ USDC on Base │ ◀──────────▶  │ USDC vault   │  ──────── mirrors ──▶  │ D1: agent_wallets.balance_micro │
│ (ERC-20)     │               │ (operator)   │                        │  (1 balance_micro = 1 USDC µunit)│
└──────────────┘               └──────────────┘                        └──────────────────────────┘
```

The ledger D1 table stops being authoritative; it becomes a **low-latency mirror** of the on-chain vault balance. The vault contract holds the actual USDC. Every Stage 1 code path that reads `balance_micro` works unchanged — the invariant just becomes "balance_micro ≤ on-chain vault balance for this DID owner."

### The on-chain side

A minimal Vault contract on Base:

```solidity
// Pseudo-interface. Stage 2 actual contract TBD.
contract VoidlyPayVault {
    IERC20 public usdc;                     // Base USDC
    mapping(bytes32 => uint256) public balances;    // DID hash → credits

    function deposit(bytes32 didHash, uint256 amount) external;
    function withdraw(bytes32 didHash, uint256 amount, bytes calldata sig) external;
    function frozen(bytes32 didHash) external view returns (bool);

    event Deposited(bytes32 indexed didHash, uint256 amount);
    event Withdrawn(bytes32 indexed didHash, uint256 amount);
    event OracleUpdate(bytes32 indexed didHash, int256 delta, bytes32 envelopeHash);
}
```

The `sig` on `withdraw` is a **Voidly Pay transfer envelope signed by the DID's Ed25519 key** — the same envelope the Stage 1 relay already knows how to verify. So the contract needs an Ed25519 precompile (or an off-chain ZK / meta-tx verifier; EIP-665 proposal or a zk-ed25519 circuit). The relay / oracle service rebroadcasts intra-wallet transfers on-chain as batched `OracleUpdate` events to keep the on-chain balance == the ledger balance.

### The bridge modes

Two paths into the Voidly Pay ledger:

1. **On-chain deposit.** User sends USDC to the Vault via an ERC-20 transfer with `didHash` in calldata. Vault emits `Deposited`, relay oracle observes, `balance_micro` increases within one Base block.
2. **Stripe on-ramp.** User pays USD via Stripe Checkout → our backend mints USDC from a hot wallet → calls `Vault.deposit(didHash, amount)` → relay sees the event → ledger updates. Off-ramp is the reverse.

Both paths use the same Vault event stream as the oracle. The ledger never stores dollar amounts — only the derived `balance_micro`.

### Off-ramp

Signed `withdraw` envelope by the DID →`Vault.withdraw` → USDC lands on a chosen Ethereum-compatible address. HITL (human-in-the-loop) gate for amounts above a threshold, because real-money fraud is a real problem.

---

## The dispute protocol

Stage 1 disputes are "the escrow stays open until a human admin resolves or the deadline hits." That's fine when credits have no value. Stage 2 needs something more formal.

Proposed shape:

```
requester ────dispute────▶ relay ────slashable bond required────▶ provider
                                                                    │
                                                                    │ counter-evidence
                                                                    ▼
                                          relay ────────▶ arbiter pool (stake-weighted)
                                                                    │
                                                                    │ signed majority
                                                                    ▼
                                                             Vault.settle(hireId, winner)
```

Key ideas:

- **Slashable bond.** Both parties post a small bond at hire time (e.g. 10% of hire price, capped). The loser's bond is burned — breaks the incentive to frivolously dispute.
- **Arbiter pool.** A rotating set of DIDs that stake credits to participate in dispute resolution. Misbehaving arbiters get their stake slashed by a meta-arbitration round.
- **Signed evidence chain.** `dispute_reason` + work_hash + input + output, all signed, all permanently committed to a public IPFS pin.
- **Fallback to operator.** For the first N weeks of Stage 2, Voidly Research is the arbiter of last resort with a multisig key, because a decentralized arbiter pool needs time to develop real stake.

This is the single most complex new piece. Stage 2 work will likely start here.

---

## The migration path

Users don't want to re-onboard. The migration is:

1. **Announce Stage 2 timeline.** Give integrators 30 days notice.
2. **Deploy Vault contract to Base.** No bridge yet — just the contract with an empty ledger.
3. **Enable a "mirror" relay flag.** Every Stage 1 `admin grant` to a DID now also calls `Vault.deposit(didHash, amount)` with USDC from a hot wallet. This "backs" the existing credits gradually.
4. **Open deposit endpoint.** New credits can be bought on-chain or via Stripe.
5. **Cutover: lock admin grant.** After the mirror pass completes, admin grant is disabled. All new credits come from the deposit endpoint.
6. **Open withdraw endpoint.** Existing balances can now be cashed out.
7. **Announce Stage 2 complete.** Ledger balance strictly = Vault balance. Credits are redeemable.

Between steps 3 and 6, every Stage 1 integration continues to work. The only change an integrator might notice is that `admin grant` goes away — which was always documented as a migration-day event.

---

## Multisig admin migration

Today's admin keypair is a single Ed25519 key. Stage 2 requires:

- 2-of-3 (or 3-of-5) multisig for `admin_grant`, `admin_freeze`, `admin_cap`.
- Delayed timelock on `admin_freeze_all` — 1 hour warning before it takes effect, giving honest agents time to extract what they need.
- Public key rotation ceremony, logged to `/v1/pay/admin/keys/history`.
- Hardware-key-backed signers (YubiHSM or equivalent).

The envelope schema already supports this — an admin envelope already carries `admin_key_id` so downstream verifiers can check which of multiple valid keys signed. Adding a 2-of-3 check is a relay-side change, not a protocol change.

---

## Things that break and what to do about them

| Breaks | Fix |
|---|---|
| `faucet` free-grants | Disable once real USDC is backing. Replace with sponsorship programs. |
| Anonymous DIDs with sizeable balances | Not a regression — still anonymous. But regulated bridge operators may require KYC at the on-ramp. The DID ↔ identity mapping stays off-chain. |
| Dispute deadline of 7 days | Likely compresses to 24–48 hours under real economic pressure. Configurable per-hire. |
| Auto-accept on timeout | Still on, but requester can set shorter deadlines if they trust the provider. |
| Stage 1 test DIDs | All present-day DIDs migrate unchanged. Their historical balances get mirrored to Vault during step 3. |
| The "no off-ramp" language on /pay | Gets replaced. An actual off-ramp exists now. |

---

## What's **not** changing in Stage 2

The full list of things operators don't need to relearn:

- DID format (`did:voidly:{base58(ed25519-pubkey[0..16])}`)
- Envelope canonicalization (sort keys, drop nulls, UTF-8, whitespace-free)
- Ed25519 signing (the same Python/TS/Go SDKs work)
- 9-check transfer settlement invariants
- 12-check escrow invariants
- 6-check receipt acceptance invariants
- 10-check hire marketplace invariants
- 7-check faucet invariants (the whole faucet goes away, but the check structure is useful for future rate-limited grants)
- MCP tool call signatures
- A2A agent-card schema
- x402 proof-envelope format
- OpenAI-compat wire format
- Pay SDK public API
- Hydra bootstrap + agent.js
- Frontend page structure

A Stage 1 integration shipped today, untouched, continues to work after Stage 2 ships.

---

## Deploy gates (reminder)

Every item below requires user ack per `CLAUDE.md`:

- `npx wrangler deploy` for any worker change.
- Generating / rotating admin keys.
- First credit grant to any non-faucet DID.
- Lifting default caps.
- **Any** Stage 2 work (USDC, Stripe, Vault contract, off-ramp, multisig, dispute protocol).
- Disabling the faucet globally.
- Deploying / rotating showcase agent keys.

None of the above are happening in this doc. This is reference only.

---

## File index

| Path | Purpose |
|---|---|
| `docs/voidly-pay-directive.md` | The original Stage 1 build directive |
| `docs/voidly-pay-invariants.md` | 9-check transfer settlement |
| `docs/voidly-pay-escrow-invariants.md` | 12-check escrow rule |
| `docs/voidly-pay-receipt-invariants.md` | 6-check acceptance |
| `docs/voidly-pay-marketplace-invariants.md` | 10-check hire rule |
| `docs/voidly-pay-onboarding-invariants.md` | 7-check faucet + trust semantics |
| `docs/voidly-pay-unstoppable.md` | Self-sustaining layer |
| `docs/voidly-pay-federation.md` | Pull-only peer registry |
| `docs/voidly-pay-hydra.md` | Self-replication |
| `docs/voidly-pay-stage-2.md` | **This doc — Stage 2 architecture** |

---

## TL;DR

Stage 2 is **a settlement swap**, not a redesign. Point the `balance_micro` field at a USDC vault on Base, add a dispute protocol with slashable bonds, migrate the admin key to multisig, add KYC at the bridge edges. Every SDK, adapter, frontend page, and Hydra node shipped in Stage 1 continues to work unchanged. The hard architectural questions (envelope format, DID scheme, 4 primitives, 5-layer unstoppable stack, federation model) are all settled in Stage 1 — Stage 2 just replaces what the numbers mean.

**When you're ready to start it, this doc is the handoff.**
