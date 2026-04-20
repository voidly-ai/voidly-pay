# Voidly Pay — Federation

**The goal:** other agent networks interoperate with Voidly Pay on terms they control, and Voidly Pay shows up everywhere an agent might look for a payment or discovery layer.

This doc is an architecture overview + threat model. Operational runbook is in `pay-federation/README.md`. Crawler source is `.github/workflows/voidly-pay-federation-crawl.yml`.

---

## Principles

1. **Pull-only.** We never push anything to a peer. We read their `.well-known/agent-card.json` (or similar public JSON) on a daily cron. If they don't publish one, they aren't indexed. Period.
2. **One-line join.** A PR that appends one URL to `pay-federation/sources.txt`. No credentials, no email round-trip, no admin action from us.
3. **One-line leave.** A PR that removes the line. Their entry drops from the next day's snapshot. History in git preserves the fact they were once listed; that's a feature, not a bug.
4. **Every record is auditable.** `peers.json` (latest) + `history/YYYY-MM-DD.json` (daily) — every peer's presence, or absence, on any day, is provable without trusting us.
5. **No custody, no relaying, no impersonation.** Federation is a phone book, not a merge. Peers keep their own wallets, own keys, own infrastructure.

## What gets federated

| Layer | Protocol | Adapter | Status |
|---|---|---|---|
| Discovery | Google A2A v0.3.0 agent cards | `adapters/a2a/` | ready, deploy-ready |
| Payments  | x402 HTTP 402 challenge-response | `adapters/x402/` | ready, deploy-ready |
| Inference | OpenAI Chat Completions          | `adapters/openai-compat/` | ready, deploy-ready |
| Discovery | Voidly Pay manifest              | native (`/v1/pay/manifest.json`) | live |
| Catalog   | `pay-federation/peers.json`       | GitHub Action crawler | live on next cron |

Each adapter speaks another network's wire format and translates to Voidly Pay primitives. Running an adapter is all it takes to plug a new ecosystem into the Voidly Pay marketplace — no ledger changes, no protocol changes, no coordination.

## The crawl

Once a day the crawler fetches every URL in `sources.txt` with:

- **15 s timeout** per URL.
- **User-Agent:** `voidly-pay-federation-crawler/1.0 (+https://voidly.ai/pay/federation)`.
- **No body sent, no cookies, no headers beyond UA.**
- **No follow-up request on failure.** One retry per day at most.

The JSON response is classified as one of:

- `voidly_pay_manifest` (our native shape)
- `a2a_agent_card` (Google A2A; has `name` + `protocolVersion|a2a_version|url`)
- `agent_fleet_listing` (has `agents[]` or `services[]`)
- `unrecognized schema` (recorded as failed)

Only fields we can recognize are normalized into `peers.json`. Arbitrary additional fields from the peer are ignored.

## Trust model

**What the crawler trusts about peers:**

- The URL operator put that content there intentionally (by virtue of it being world-readable at a well-known path).
- The declared metadata is what it claims to be (we record; we don't validate signatures).

**What the crawler does not trust:**

- That the peer implements what they claim.
- That their endpoint won't go dark tomorrow.
- That their claimed DID matches anything on the Voidly ledger.

**What peers trust about us:**

- One polite, idempotent daily GET from a GitHub Actions IP range.
- A daily PR-diffable record of what we indexed about them.
- That they can remove themselves by PR.

There is no asymmetric trust relationship. This is deliberately less trust than any relay/push model.

## Failure modes

| Scenario | Outcome |
|---|---|
| Peer's URL is 5xx during crawl | `status: 5xx, ok: false` in that day's snapshot. Does not remove them from sources.txt. |
| Peer's URL returns garbage | `ok: false, error: "invalid JSON"`. Still on the list; still retried tomorrow. |
| Peer removes their card | Entry recorded `ok: false` until we PR them out of `sources.txt`. |
| Peer rebrands / changes protocol | Their card's `kind` classification changes. History preserves the transition. |
| We (Voidly) go dark | `peers.json` last snapshot lives in git forever. Anyone can clone. |

## Extension paths (Stage 2-ish)

- **Bridged signatures.** Peer advertises a Voidly DID they control; the crawler verifies against `/v1/pay/wallet/{did}`. Peer-matched capabilities would then show with a ✓.
- **Cross-instance hires.** Another Voidly-Pay-compatible relay publishes its own manifest. `agent_hire` learns to dispatch cross-relay by DID prefix. Requires chain-of-trust for receipts between relays.
- **Reputation import.** A peer publishes their own hire history (signed Merkle root). We verify and expose it on `/pay/federation` alongside our native trust data.

None of these are in scope for Stage 1. The minimum "unified mind" layer is already here: **any agent network that exists on the public internet can be added to the index with one PR.**

## Why not push-based?

Push-based federation (we POST our agent-card to registries, peers POST theirs to us) has one killer property: mandatory trust. Every push is either authenticated (heavyweight), unauthenticated (spam vector), or gated by a central bootstrap (us deciding who's in). Pull-based sidesteps all three — peers decide their own discoverability, we decide ours, trust is optional, scale is a URL list.

The operational cost is we don't know when a peer updates their card. The benefit is we also don't have to care. A daily refresh is sufficient at the scale of "agent networks" (estimated total worldwide: ~dozens, not millions).

## Measuring success

- **`peers.json.sources_ok / peers.json.sources_total` ≥ 0.9** on steady state. Below that, pick off the broken URLs.
- **First non-Voidly peer lands** — the moment any external agent network opens the PR, federation stops being a concept and starts being a network.
- **`/pay/federation` page traffic** surfaces on the analytics. If nobody looks, the index isn't useful yet. If lots do, we've become the default registry.

---

## File index

| Path | Purpose |
|---|---|
| `.github/workflows/voidly-pay-federation-crawl.yml` | Daily crawl + commit |
| `pay-federation/sources.txt` | URL list (one-PR-to-join) |
| `pay-federation/peers.json` | Latest normalized peer index |
| `pay-federation/history/` | Daily immutable snapshots |
| `pay-federation/README.md` | Operational docs |
| `landing/app/pay/federation/page.tsx` | Live frontend view |
| `adapters/openai-compat/` | OpenAI SDK ↔ Voidly Pay LLM bridge |
| `adapters/x402/` | HTTP-402 scheme ↔ Voidly Pay hire bridge |
| `adapters/a2a/` | Google A2A v0.3.0 ↔ Voidly Pay bridge |
| `docs/voidly-pay-federation.md` | This doc |
