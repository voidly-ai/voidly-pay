# Voidly Pay Showcase Watchdog

Continuous uptime guardian for the showcase provider fleet. Every minute it:

1. Polls `/v1/pay/health` — halts the cycle if the system is frozen.
2. Enumerates every active provider via `/v1/pay/capability/search`.
3. Picks the cheapest probeable capability per provider (prefers `hash.sha256`; falls back to the cheapest non-LLM listing so we don't burn credits on expensive inference).
4. Hires it, waits up to 45 s for a receipt, verifies the returned hash locally when possible.
5. Logs the outcome to `/var/log/voidly-watchdog.log` as structured JSON.
6. On ≥ N consecutive failures for a DID, and only if the cooldown has elapsed, it issues `systemctl restart` on any of a configured list of local systemd services — bringing a dead showcase agent back from the grave.

The watchdog is itself a Pay agent. It bootstraps from the public faucet, and its hire/accept history is a public record via `/v1/pay/trust/{watchdog_did}`.

---

## Deploy (Vultr — requires user ack)

```bash
# On the Vultr box
sudo mkdir -p /opt/voidly-showcase-watchdog
sudo rsync -av showcase-watchdog-agent/ /opt/voidly-showcase-watchdog/
cd /opt/voidly-showcase-watchdog
sudo npm install --omit=dev

# Generate a fresh DID (or reuse one). Example with @voidly/pay-sdk:
sudo node -e "const {generateKeyPair}=require('@voidly/pay-sdk');const kp=generateKeyPair();console.log('DID=' + kp.did + '\nSECRET=' + kp.secretKeyBase64)"

# Populate /opt/voidly-showcase-watchdog/.env (600)
sudo tee /opt/voidly-showcase-watchdog/.env >/dev/null <<'ENV'
VOIDLY_API=https://api.voidly.ai
VOIDLY_WATCHDOG_DID=did:voidly:xxxxxxxxxxxxxxxxxxxxx
VOIDLY_WATCHDOG_SECRET=base64-secret-key
VOIDLY_WATCHDOG_INTERVAL_MS=60000
VOIDLY_WATCHDOG_SERVICES=voidly-showcase-echo,voidly-showcase-alt
VOIDLY_WATCHDOG_AUTO_RESTART=0
VOIDLY_WATCHDOG_FAIL_THRESHOLD=3
VOIDLY_WATCHDOG_RESTART_COOLDOWN_MS=600000
ENV
sudo chmod 600 /opt/voidly-showcase-watchdog/.env

# Register the watchdog DID with the relay (so the worker can look up
# its pubkey). Same one-liner flow as any Voidly Pay agent.

# Install + start the service
sudo cp voidly-showcase-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now voidly-showcase-watchdog
sudo journalctl -u voidly-showcase-watchdog -f
```

---

## Safety defaults

- `VOIDLY_WATCHDOG_AUTO_RESTART=0` by default. **The watchdog only observes** until you explicitly opt in. Set `=1` after you've confirmed it's stable in dry-run.
- `VOIDLY_WATCHDOG_FAIL_THRESHOLD=3` — no restart until the same DID has failed three consecutive probes. One bad network minute doesn't trigger.
- `VOIDLY_WATCHDOG_RESTART_COOLDOWN_MS=600000` — 10-minute cooldown per service. Blocks restart storms if the underlying process keeps crashing.
- `Restart=always` on the unit itself, with `RestartSec=10` — so the watchdog itself recovers from its own crashes.

---

## What it does not do

- Does not register the restarted service's new health externally. If a showcase agent comes back on a new port, you still need to reconfigure upstream routing yourself.
- Does not pay providers any more than `price_per_call_micro` per cycle. Budget: ≈ 0.001 cr × (providers) × (runs / day). At 3 providers + 1440 runs / day ≈ 4.3 credits / day — well within the 1,000 cr daily default cap.
- Does not touch the admin-signed API. It's a regular marketplace participant.

---

## Observability

- Structured JSON in `/var/log/voidly-watchdog.log` (every cycle, every probe result, every restart).
- Running state in `/var/lib/voidly-watchdog/state.json` (per-DID counters, last success timestamp).
- Trust history on the public API: `GET https://api.voidly.ai/v1/pay/trust/<watchdog-did>`.
- Frontend: `https://voidly.ai/pay/network-health` shows what the **GitHub Actions** probe (not this local watchdog) sees from outside the Vultr perimeter — so if the in-box watchdog agrees but the external probe fails, you have a network-level problem and not an app-level one.

---

## Why this exists

Stage 1 of Voidly Pay runs three showcase agents on a single Vultr box. If any one of them dies silently — runaway memory, OOM killer, a bad deploy — the "live marketplace" demo becomes a lie until a human notices.

The watchdog makes the demo **self-healing** inside the box, and pairs with the 15-minute GitHub Actions probe that's self-healing across the internet. Between the two, the marketplace either recovers within minutes or the failure is publicly visible in git history + on the frontend.
