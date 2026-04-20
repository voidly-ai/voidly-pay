# Voidly Pay Hydra — one-command provider spin-up

The Hydra pattern: cut one head off, two grow back. Bring a fresh Voidly Pay provider online — with its own DID, its own funded wallet, its own published capability, and a listing in the federation index — in one command.

## Why this exists

Stage 1 currently runs three showcase agents on one Vultr box. A single point of failure. Hydra fixes that by making **the act of standing up another provider trivial**. Any machine that can run Node.js becomes a Voidly Pay provider in under two minutes. Five minutes if it also joins the federation index. The more operators run `hydra-bootstrap`, the more resilient the whole network becomes.

Nothing here is privileged. Every action is one that any user could take manually — bootstrap just scripts them together.

## Quickstart — pick whichever matches your setup

### 1. npm (zero install)
```bash
npx @voidly/pay-hydra init
npx @voidly/pay-hydra run
```

### 2. Docker (one container)
```bash
docker run -d --name voidly-hydra \
  -v voidly-hydra-data:/data \
  -p 8420:8420 \
  --restart always \
  voidly/pay-hydra
# or via compose:
docker compose up -d
```

### 3. Terraform (any cloud VM)
```bash
cd pay-hydra/terraform/digitalocean    # or aws-lightsail
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply
```

### 4. Helm (Kubernetes)
```bash
cd pay-hydra/helm
helm install voidly-hydra ./voidly-pay-hydra
```

### 5. Source tarball (reference / hackable)
```bash
# Canonical source distribution is the npm package. To hack on it:
npm pack @voidly/pay-hydra
tar -xzf voidly-pay-hydra-*.tgz
cd package && chmod +x bin/cli.js && ./bin/cli.js init
```

(Upstream repo `voidly-ai/voidly-pay` is private; the published npm tarball is the public source.)

## What it does, in order

1. **Verify Node ≥ 18 and install** `@voidly/pay-sdk` in a scratch dir.
2. **Generate a fresh Ed25519 keypair.** DID printed, secret saved to `~/.voidly-hydra/keys/<did>.json` (mode 600).
3. **Register the DID with the relay** via `POST /v1/agent/register` so the worker can look up the pubkey.
4. **Claim the faucet** for 10 starter credits (only works once per DID per IP).
5. **Publish at least one capability.** Default: `echo.lite` @ 0.0005 cr (the cheapest sane default — cheaper than the existing showcase to incentivize hires). Configurable via `--capability`, `--price`, `--sla`.
6. **Start an HTTP server** on `0.0.0.0:$PORT` (default 8420) that listens for hires (the `provider` mode). It polls `/v1/pay/hire/incoming/<did>` every 10 s, fulfills, submits work claims.
7. **Optionally open a PR against `pay-federation/sources.txt`** adding this node's agent-card URL (manual toggle — the operator must confirm).

## Modes

```bash
./bootstrap.sh                          # full bootstrap (default)
./bootstrap.sh --mode=provider          # just run the provider loop (existing DID)
./bootstrap.sh --mode=probe             # run as a requester probe instead
./bootstrap.sh --mode=watchdog          # run as watchdog only (no provider)
./bootstrap.sh --capability=hash.sha256 # pick the default capability to host
./bootstrap.sh --price=0.0005           # price in credits per call
./bootstrap.sh --sla-hours=1            # max hours to fulfill
./bootstrap.sh --port=8420              # HTTP listen port
./bootstrap.sh --federation-pr=0        # don't open the federation PR
```

## Systemd install (production)

```bash
./bootstrap.sh --install-systemd
```

Creates `/etc/systemd/system/voidly-hydra-provider.service` (hardened like `showcase-watchdog-agent/voidly-showcase-watchdog.service`), enables it, prints status. Reboot-safe.

## Safety defaults

- Default capability is `echo.lite` — a benign one that can't be abused. Opt in to anything more specific.
- Daily spend cap stays at the ledger default (1,000 cr/day). Since you're a *provider*, you won't be spending credits — you'll be earning them — but the cap protects you if you get hacked.
- Federation PR is OFF by default. If you want your node in the public index, pass `--federation-pr=1`.
- Secret key is never logged. It's written once to `~/.voidly-hydra/keys/<did>.json` (mode 600) and not re-read by the bootstrap script after handoff.
- The script does NOT touch system firewall rules — you must open `--port` yourself if you want the provider reachable externally.

## Why not Docker?

A single bash+Node pair is auditable on GitHub in one window. Dockerfiles are fine but they hide dependencies behind an opaque image. Anyone can skim `bootstrap.sh` + `agent.js` in 10 minutes. That's the security model.

---

## Unifying the protocol layer

Hydra is the third leg of Voidly Pay's self-sustainability stool:

| Layer | What fails if it goes dark | What keeps going |
|---|---|---|
| **Showcase fleet on Vultr** | One box, three agents | — |
| **External GitHub probe** (`voidly-pay-network-health.yml`) | Vultr box or whole Voidly stack | Probe results in `pay-health/` + frontend renders them |
| **Inside-box watchdog** (`showcase-watchdog-agent/`) | A single systemd service hangs | Watchdog restarts it |
| **Hydra bootstrap** (this) | Everything Voidly runs | Any operator anywhere stands up a new provider in minutes; federation index picks them up the next day |

Put differently: take Voidly's infrastructure completely offline, and an existing Hydra operator with `@voidly/pay-sdk` installed still has a working agent. The ledger is on Cloudflare — yes — but the wire format + envelope schema + signing keys are all in the SDK. A replacement ledger is a compatible Worker + D1 instance away; adapters and bootstrappers continue working unchanged.

---

## Files

| Path | Purpose |
|---|---|
| `bootstrap.sh` | POSIX bash entrypoint. Reads flags, shells to Node. |
| `agent.js` | Node.js long-running worker — provider / probe / watchdog modes. |
| `package.json` | One dep: `@voidly/pay-sdk`. |
| `voidly-hydra-provider.service` | systemd unit (hardened). |
| `README.md` | This file. |
