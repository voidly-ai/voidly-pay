# Voidly Pay — the self-sustaining layer

**Goal:** make the Voidly Pay marketplace run without a human in the loop and keep running even when individual components fail.

"Unstoppable" here means: if any one of the provider VMs, the GitHub Actions runner, the frontend, or an SDK version goes dark, the rest keeps the marketplace alive, a record of the failure is public and tamper-evident, and a recovery path exists.

This is a layered design. Each layer adds resilience on top of the one below it.

---

## Layer 0 — the baseline (already in prod)

| Component                             | Behavior                                                   |
|---------------------------------------|------------------------------------------------------------|
| Cloudflare D1 ledger                  | Atomic settlement. UNIQUE constraints on nonces.           |
| Cloudflare Worker cron                | Every 5 min: sweep past-deadline escrows + stale receipts. |
| Default caps (1,000 / day, 100 / tx)  | Bounds blast radius of any one compromised key.            |
| Emergency kill-switch                 | `pay_system_state.system_frozen = 1` halts writes.         |
| 104 / 104 test suite                  | Money code invariants locked in CI.                        |

## Layer 1 — the autonomous fleet (already in prod)

| Component                                             | Behavior                                                              |
|-------------------------------------------------------|-----------------------------------------------------------------------|
| `voidly-showcase-echo` (`did:voidly:Eg8JvTNrBLcpbX3r461jJB`)   | 11 live capabilities @ 0.001–0.05 cr each. systemd `Restart=always`. |
| `voidly-showcase-alt` (`did:voidly:AsAVzZ2dtMrntgGRco8KkW`)   | 4 capabilities. Undercuts `hash.sha256` at 0.0008 cr.                |
| `voidly-showcase-probe` (`did:voidly:XM5JjSX3QChfe5G4AuKWCF`) | Every 5 min: faucet → search → hire → verify → accept/dispute.       |
| GitHub Actions hourly probe                           | Fresh DID every run. Public proof the flow works end-to-end.         |
| HF Collection + daily Dataset snapshot                | Off-platform backup of marketplace state.                            |

**Failure mode covered:** any single service on the Vultr box crashing. systemd brings it back. If systemd is gone, the box is gone (hardware-level).

## Layer 2 — external watchdog (this commit)

| Component                                   | Behavior                                                                    |
|---------------------------------------------|-----------------------------------------------------------------------------|
| `voidly-pay-network-health.yml` (every 15m) | Full external hire-verify against every known provider. Commits JSON to git. |
| `pay-health/latest.json` + `history/`       | Tamper-evident uptime record, publicly accessible.                           |
| `/pay/network-health`                       | Live frontend view of the same data.                                         |
| Job exits non-zero on total failure         | GitHub notification when every provider is dark at once.                     |

**Failure modes covered:**

1. A provider silently stops accepting hires but systemd reports healthy. → probe fails, committed to git, surfaces on the frontend.
2. Cloudflare's regional outage makes us unreachable from the east coast. → the GitHub runner (on a different network) still probes; it either agrees (real outage) or succeeds (transient regional), and we can triangulate.
3. The whole Vultr box goes down. → all providers fail in one cycle; job is red; notification; the frontend shows red.

## Layer 3 — inside-the-box watchdog (`showcase-watchdog-agent/`)

| Component                                  | Behavior                                                                                  |
|--------------------------------------------|-------------------------------------------------------------------------------------------|
| `voidly-showcase-watchdog.service` (1 min) | Every cycle hires every non-self provider, verifies, logs, updates state.                 |
| `VOIDLY_WATCHDOG_AUTO_RESTART=1`           | After N consecutive failures on a DID, restart configured systemd services (cooldowned).  |
| Is itself a Pay agent                      | Trust history publicly visible via `/v1/pay/trust/<watchdog-did>`.                        |

**Failure modes covered:**

4. A showcase agent's process stops responding but systemd thinks it's fine (hung, not crashed). → the watchdog notices fail streak, issues `systemctl restart`, service comes back.
5. External probe is the one lying — network partition between GitHub and Cloudflare. → in-box watchdog reports providers healthy, external reports down; operator knows to look at the edge.

## Layer 4 — economic self-regulation (`auto-pricing.js`)

| Component                          | Behavior                                                                                                     |
|------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `auto-pricing.js` (opt-in, per-run)| Repositions listings relative to live competitors. Undercut when losing; drift when solo; bounded raise when dominant. |

**Why this matters:** a marketplace with fixed prices isn't really a market. This closes the loop — providers adjust, requesters see the cheapest option, and `GET /v1/pay/capability/search` stays useful as a price-discovery API instead of a static catalog.

**Safety rails:** floor, ceiling, max-delta-per-run, minimum-hires-before-deciding, an `AUTO_PRICING_ENABLED` env gate. Disabled by default.

## Layer 5 — distribution surfaces that outlast the origin

| Surface                       | Role                                                                     |
|-------------------------------|--------------------------------------------------------------------------|
| `@voidly/pay-sdk` (npm)       | Wire protocol knowledge lives in the SDK, not the frontend.              |
| `voidly-pay` (PyPI)           | Same, for Python.                                                        |
| `@voidly/pay-cli` (npm)       | Any CI runner can transact from a terminal.                              |
| `@voidly/mcp-server` (npm)    | Any MCP client (Claude / Cursor / Windsurf / n8n) gets the tools.        |
| ClawHub skill `voidly-pay`    | Agent-skill marketplace distribution.                                    |
| HuggingFace Space + Dataset   | Dashboard + daily snapshots of the live state.                           |
| Public markdown specs (`/voidly-pay*.md` on voidly.ai) | Wire format + invariants checkable without running the service. |

Each of these is a cached copy of the Voidly Pay protocol. If voidly.ai disappeared tomorrow, every SDK + every cached spec + every HF snapshot would still exist — enough for anyone to spin up a compatible clone.

---

## What's **not** yet covered

These are the honest gaps. Each is a feature request, not a vulnerability:

- **Sybil-resistant faucet** — IP rate-limited only. A motivated attacker can burn through DIDs. See Stage 2 item 9.
- **Multi-region provider fleet** — everything currently lives on one Vultr box. A regional outage takes us down.
- **No off-ramp** — Stage 1 credits have no value by design. The "unstoppable" property is about availability of the protocol, not preservation of economic value.
- **Cloudflare dependency** — the Worker, D1, and Pages all live on CF. This is the hard dependency. Stage 2 (USDC on Base) weakens it by moving settlement to chain.

---

## Invocation order when something goes wrong

1. **Is the whole service down?** `https://api.voidly.ai/v1/pay/health` — if 5xx, see CF status page + worker tail logs.
2. **Is it frozen?** Same endpoint — `system_frozen` flag.
3. **Is a provider broken?** `https://voidly.ai/pay/network-health` + `pay-health/latest.json` in the repo.
4. **Is it Vultr-side?** `systemctl status voidly-showcase-echo`, `voidly-showcase-alt`, `voidly-showcase-probe`, `voidly-showcase-watchdog`.
5. **Was a deploy the cause?** `git log pay-health/latest.json` — the last good snapshot timestamps the regression.
6. **Did we burn the faucet?** `GET /v1/pay/stats` — `wallets.total` climbing without `hires.total` climbing = abuse.
7. **Kill switch:** `POST /v1/pay/admin/freeze_all` halts every write on the ledger in a single signed call.

---

## File index (for this design)

| Path                                                       | Purpose                                                   |
|------------------------------------------------------------|-----------------------------------------------------------|
| `.github/workflows/voidly-pay-network-health.yml`          | Layer 2 — external probe, every 15 min.                   |
| `pay-health/latest.json`                                   | Layer 2 — most recent report.                             |
| `pay-health/history/`                                      | Layer 2 — immutable record.                               |
| `landing/app/pay/network-health/page.tsx`                  | Layer 2 — frontend view.                                  |
| `showcase-watchdog-agent/agent.js`                         | Layer 3 — inside-the-box watchdog.                        |
| `showcase-watchdog-agent/voidly-showcase-watchdog.service` | Layer 3 — systemd unit (hardened).                        |
| `showcase-echo-agent/auto-pricing.js`                      | Layer 4 — repricing module.                               |
| `docs/voidly-pay-unstoppable.md`                  | This doc.                                                 |

---

## Measuring success

After 30 days of this being live, the three things to check:

1. **`pay-health/history/` size** ≥ ~2,880 files. That's two probes an hour × 15 min cadence × 30 days = the sampler is doing its job.
2. **Zero rows in `pay-health/history/*.json` with `summary.providers_ok === 0`.** Any file with that value is a "total blackout" minute — and if that happens, `git log` names the exact 15-minute window it was down, which is more forensic detail than most commercial SaaS status pages provide.
3. **Auto-pricing has caused at least one undercut-or-match observable in `/v1/pay/capability/search` sort order.** Means the market is alive enough to have found an equilibrium, not just a static catalog.
