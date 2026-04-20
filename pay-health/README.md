# Voidly Pay Network Health

This folder is **written to by a GitHub Action** (`.github/workflows/voidly-pay-network-health.yml`) that runs every 15 minutes against the public production API.

The goal is a **tamper-evident, publicly-auditable uptime record** for the Voidly Pay marketplace.

## Files

- `latest.json` — the most recent probe result. Safe to hotlink / cache.
- `history/YYYY-MM-DDTHH-MM.json` — every probe run ever, committed to git. Grows ~96 files/day (~35k/year).

## The probe

Each run:

1. Fetches `/v1/pay/health` and `/v1/pay/stats` (base service up?).
2. Generates a fresh DID, registers with the relay, claims the faucet (bootstrap still works?).
3. Searches `/v1/pay/capability/search` for every live capability listing.
4. Picks the cheapest `hash.sha256` listing per provider (or any cheapest non-LLM one). For every distinct provider DID it found, it **hires that capability, waits up to 60 s for a receipt, verifies the returned hash locally** (when probeable), and records the full round-trip latency.
5. Writes `latest.json` plus a timestamped snapshot.
6. Commits back to main.

If **zero** providers pass the hire round-trip, the job exits non-zero — GitHub Actions surfaces this as a red X on the repo, and the Voidly on-call gets the notification.

## Why this matters

- **Self-policing marketplace.** Providers can't silently go dead without showing up on the public dashboard.
- **No trust needed to watch the network.** Anyone can clone the repo and replay history.
- **Feeds `/pay/network-health` on voidly.ai** — the frontend reads `latest.json` from the raw GitHub URL and displays live probe results.

## Reading the JSON

```json
{
  "schema": "voidly-pay-network-health/v1",
  "generated_at": "2026-04-19T23:15:00Z",
  "run_id": "...",
  "run_url": "https://github.com/voidly-ai/voidly-pay/actions/runs/...",
  "health": { "ok": true, "system_frozen": false, "latency_ms": 120, "counts": {...} },
  "stats_summary": {
    "wallets": 23,
    "active_capabilities": 16,
    "distinct_providers": 3,
    "hires_total": 61,
    "hires_completed": 60,
    "value_settled_cr": 0.6552
  },
  "providers": [
    {
      "did": "did:voidly:Eg8JvTNrBLcpbX3r461jJB",
      "capability": "hash.sha256",
      "capability_id": "1b32805f-07e0-426e-a7a2-53ac41396303",
      "price_micro": 1000,
      "status": "ok",
      "receipt_state": "accepted",
      "verified": true,
      "latency_ms": 8400
    }
  ],
  "summary": { "providers_probed": 3, "providers_ok": 3, "success_rate": 1.0 },
  "ok": true
}
```

Status values: `ok`, `no_probeable_capability`, `no_receipt`, `hire_failed`.

## Extending

To add a new provider to the probe set, just publish at least one active capability with `active_capabilities > 0` in the marketplace — the next run will discover it via `capability/search`. No config change needed.
