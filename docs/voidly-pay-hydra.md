# Voidly Pay Hydra — self-replicating provider pattern

**The problem Hydra solves:** everything useful in the Voidly Pay Stage 1 deployment runs on a single Vultr box. If that box goes dark — hardware failure, billing issue, datacenter outage — the whole "live marketplace" demo stops being live. The watchdog restarts services but can't restart the box.

**The Hydra fix:** make it trivial for any third party to stand up an additional, independent Voidly Pay provider. No coordination with us. No permissions. Any machine that can run Node.js becomes a full-participation marketplace member in under two minutes.

The more Hydra nodes exist, the more resilient the marketplace becomes. And the act of running one is zero-maintenance after bootstrap.

---

## Single-command install

```bash
npx @voidly/pay-hydra init && npx @voidly/pay-hydra run   # zero-install via npm
# or: docker run -d -v voidly-hydra-data:/data -p 8420:8420 voidly/pay-hydra
```

(or clone-and-run for private-repo operators)

What it does:

1. Generates a fresh Ed25519 keypair → `~/.voidly-hydra/keys/active.json` (mode 600).
2. Registers the DID with the relay so signature verification works.
3. Claims the faucet (10 starter credits — IP-rate-limited by the ledger).
4. Publishes a capability: `echo.lite` @ 0.0005 cr/call by default (configurable).
5. Starts the provider loop: polls `/v1/pay/hire/incoming/{did}` every 10 s, fulfills, claims.
6. Starts a small HTTP server on port 8420 serving a live agent card at `/.well-known/agent-card.json` — the federation crawler can index it.

Every step is idempotent. Re-running the script re-uses the same DID.

---

## The three Hydra modes

```bash
./bootstrap.sh --mode=provider      # (default) host a capability, earn credits
./bootstrap.sh --mode=probe         # probe-and-verify loop (like showcase-probe-agent)
./bootstrap.sh --mode=watchdog      # observe every provider, log failures, no restart
```

Each mode is ~80 lines of the same `agent.js`. They differ only in the main loop — all share the same Pay SDK, same DID handling, same HTTP agent-card endpoint.

## Systemd production install

```bash
sudo ./bootstrap.sh --install-systemd
```

Installs `voidly-hydra.service` with heavy hardening (`ProtectSystem=strict`, `MemoryDenyWriteExecute`, `LockPersonality`, `User=nobody`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`). `Restart=always`. Reboot-safe.

---

## Default capabilities any Hydra node can host

These all compute locally in-process — no external API calls, no dependencies beyond Node crypto. A stock Hydra node can answer hires for any of them without further config:

| slug          | semantic                       | price default |
|---------------|--------------------------------|---------------|
| `echo.lite`   | return `input.text` unchanged  | 0.0005 cr     |
| `text.reverse`| reverse string                 | 0.0005 cr     |
| `text.uppercase`| uppercase string             | 0.0005 cr     |
| `text.length` | length of string               | 0.0005 cr     |
| `hash.sha256` | sha256 hex of input text       | 0.0005 cr     |

Pick one at bootstrap via `--capability=hash.sha256`. Hosting more than one on the same node means multiple runs of the bootstrap script (one per capability listing).

Anything beyond these is possible — just fork `agent.js` and add a case to the `handleDefault` function. You keep your own key, your own DID, and your own earnings.

---

## Why this is safe

- The Hydra node's DID **is only its own wallet**. It has no privileges over the ledger, other agents, or the watchdog.
- Hydra doesn't touch system firewalls — the operator opens `--port` if they want the agent-card reachable externally. If they don't, the card is still accessible locally and the provider loop still functions (hires come in via the polling call, not inbound).
- Default spend cap is the ledger default (1,000 cr/day). A compromised Hydra node can lose at most the balance it earned before the breach plus one day of faucet, which is roughly 10 cr + daily faucet velocity. Not catastrophic.
- Node.js process runs as `nobody:nogroup` under systemd. It cannot read other users' homes, mount filesystems, or load kernel modules.

## Failure modes

| If the operator... | Network outcome |
|---|---|
| Forgets to open the port | Agent card not externally reachable; provider loop still works. |
| Loses the key file | The DID is permanently lost along with its balance; that operator can re-bootstrap with a fresh DID. Nobody else is affected. |
| Gets hacked | At most `daily_cap_micro` is drained per day until they freeze the wallet (signed request) or stop the service. |
| Overprices their capability | Nobody hires them. Market self-regulates via `capability_search`'s price-ascending sort. |
| Publishes then vanishes | Federation crawler still lists them (for a day). External network-health probe flags their capability stale after 3 consecutive missed hires. Capability remains listed until they (or an admin) delist it — but requesters who read the stale list stop hiring. |

That last row is exactly what we've already caught on `did:voidly:mkt-b-1776622972` — the live probe now tracks it.

---

## How Hydra fits with the rest of the stack

```
                ┌─────────────────────────────────┐
                │  Cloudflare Worker + D1         │   ← the ledger
                │  (the only non-replicable part) │
                └─────────────────────────────────┘
                             ▲
                             │ POST /v1/pay/*
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼────┐        ┌────▼────┐        ┌────▼────┐
    │ Vultr   │        │ Hydra   │        │ Hydra   │
    │ fleet   │        │ (Alice) │        │ (Bob)   │
    │ (3 ags) │        │         │        │         │
    └─────────┘        └─────────┘        └─────────┘
                             ▲
                             │
                   ┌─────────┴─────────┐
                   │ External GitHub   │
                   │ probe (15 min)    │
                   │ + federation      │
                   │ crawler (daily)   │
                   └───────────────────┘
```

Hydra nodes participate in exactly the same ledger as the Vultr fleet. From the ledger's perspective they are indistinguishable. From the frontend's perspective they're just more providers in the marketplace browser.

The **only** non-replicable component is the Cloudflare Worker + D1. Stage 2 (USDC on Base) replaces that with an on-chain equivalent, at which point even the ledger becomes replicable.

---

## The invariant

**A new Hydra node at time T should be earning credits by time T + 5 min** — one faucet claim, one capability listing, one inbound hire cycle. If that invariant breaks, it's either a regression in the SDK or the bootstrap script, and `./bootstrap.sh --mode=probe` running from a different machine will detect it on the next cron tick.

That's the Hydra promise: a marketplace that cannot be un-spawned, because the tool to spawn a new participant is in every corner of the internet, and every participant carries a copy of the recipe.

---

## Files

| Path | Purpose |
|---|---|
| `pay-hydra/bootstrap.sh` | POSIX entrypoint, idempotent. |
| `pay-hydra/agent.js` | ~250 lines, three modes, hardened. |
| `pay-hydra/voidly-hydra-provider.service` | systemd unit. |
| `pay-hydra/package.json` | One dep: `@voidly/pay-sdk`. |
| `pay-hydra/README.md` | Operational runbook. |
| `docs/voidly-pay-hydra.md` | This doc. |

## Adjacent files

| Path | Purpose |
|---|---|
| `showcase-watchdog-agent/` | In-box-only watchdog for the showcase fleet. Similar shape. |
| `adapters/a2a/` | A2A bridge — any Hydra node can publish its agent card here for federation. |
| `adapters/langchain/`, `adapters/crewai/`, `adapters/autogen/` | Framework tools that let LLM-driven agents *hire* Hydra nodes programmatically. |
| `.github/workflows/voidly-pay-network-health.yml` | External-probe that tracks per-capability failure streaks. Catches any Hydra node that goes silent. |
| `.github/workflows/voidly-pay-federation-crawl.yml` | Indexes any Hydra node's published agent card into `pay-federation/peers.json`. |
