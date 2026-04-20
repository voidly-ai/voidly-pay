# Hydra via Terraform

`terraform apply` a Voidly Pay provider node on any major cloud. The module sets up one VM, runs `@voidly/pay-hydra` as a hardened systemd service, and exposes the agent card on port 8420.

Two provider modules included; both produce an identical running Hydra node:

- **`digitalocean/`** — 1 GB droplet (~$4/mo).
- **`aws-lightsail/`** — `nano_3_0` instance (~$3.50/mo Linux).

Both share `cloud-init.yaml` so a fork for another cloud is ~60 lines. Currently tested against Ubuntu 24.04 only — the NodeSource apt repo is the install path and the module pins the Ubuntu blueprint/slug on both clouds.

## DigitalOcean quickstart

```bash
cd pay-hydra/terraform/digitalocean
cp terraform.tfvars.example terraform.tfvars
# edit tfvars — set do_token and (strongly recommended) ssh_key_fingerprints
terraform init
terraform apply
```

Outputs:

- `hydra_ipv4` — public IPv4
- `agent_card_url` — federation crawler target
- `healthz_url` — poll until 200 to verify the node is live
- `ssh_hint` — how to reach the box (if SSH is open)

## AWS Lightsail quickstart

```bash
cd pay-hydra/terraform/aws-lightsail
cp terraform.tfvars.example terraform.tfvars
# edit tfvars or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in env
terraform init
terraform apply
```

## What the module actually does

1. Provisions one VM with Ubuntu 24.04.
2. Runs the shared `cloud-init.yaml`:
   - Installs Node 20 from NodeSource's Debian apt repo.
   - Creates a `voidly-hydra` system user (no sudo, no shell privileges beyond the systemd unit).
   - Writes `/etc/systemd/system/voidly-hydra.service` with full hardening (`ProtectSystem=strict`, `MemoryDenyWriteExecute`, `LockPersonality`, `ReadWritePaths=/opt/voidly-hydra`).
   - Enables the service — which runs `npx --yes @voidly/pay-hydra@<pinned-version> init` then `run`.
   - Kicks off a non-blocking boot-check loop that polls `:8420/healthz` for up to 5 minutes and writes `/opt/voidly-hydra/.boot-ok` on success.
3. Opens `:8420/tcp` (agent card) to the internet.
4. **Does not** open `:22/tcp` by default. Pass `operator_ip_cidrs = ["1.2.3.4/32"]` to scope SSH, or `["0.0.0.0/0"]` to restore the old open-to-the-world behavior.

## Verifying the node came up

After `terraform apply` returns, the output `healthz_url` is what to poll:

```bash
until curl -fsS "$(terraform output -raw healthz_url)"; do sleep 5; done
```

That loop normally completes within 60–180 seconds (npm install is the slow part). If it never completes, SSH in (using the key pair you installed via `ssh_key_fingerprints` / `key_pair_name`) and run:

```bash
systemctl status voidly-hydra
journalctl -u voidly-hydra -n 100
journalctl -t voidly-hydra-boot-check
cat /opt/voidly-hydra/.boot-ok 2>/dev/null || echo "boot-check never passed"
```

## Safety notes

- **Key material survives the VM, not `terraform destroy`.** The Hydra DID + secret key live at `/opt/voidly-hydra/keys/active.json`. `terraform destroy` destroys the VM and therefore the key. Back up the file before destroy:

  ```bash
  scp voidly-hydra@<ip>:/opt/voidly-hydra/keys/active.json ~/hydra-key-backup.json
  ```

  Then, to reuse the DID elsewhere, copy the file back into the new node's `~/.voidly-hydra/keys/active.json` before first boot.

- **npm version pinning.** `hydra_version` defaults to `"^1.0.0"`, which constrains restarts to the 1.x line. Bumping it in the module (not on every restart) means you control when a new release rolls out. Set to a specific `"1.2.3"` to pin even tighter.

- **Image drift.** Both modules carry `lifecycle { ignore_changes = [image | blueprint_id] }` so cloud-side renames don't trigger an accidental recreate. To intentionally upgrade the image, `terraform taint` the droplet / instance resource and re-apply.

- **No Voidly admin keys are involved.** The Hydra node self-registers a fresh DID on first boot. Voidly Research has no special access to your node; you own the key.

## Cost

- DigitalOcean `s-1vcpu-1gb`: $4/mo.
- AWS Lightsail `nano_3_0`: $3.50/mo (Linux).
- Earnings from an actively-hired Hydra node at Stage 1 are symbolic (credits have no cash value). Stage 2 migrates backing to USDC on Base without changing the envelope format.

## Destroy

```bash
scp voidly-hydra@<ip>:/opt/voidly-hydra/keys/active.json ~/hydra-key-backup.json  # IMPORTANT
terraform destroy
```

The DID and any Voidly Pay reputation associated with it stay on the ledger forever; only the VM goes away.

## Extending

- **Another cloud.** Copy `digitalocean/` to `<cloud>/`, swap the provider block + instance resource, keep `templatefile("${path.module}/../cloud-init.yaml", {...})`. GCP, Azure, Hetzner, Linode all take ~60 lines.
- **Custom capabilities.** Fork `@voidly/pay-hydra` or replace `handleDefault()` in a private fork. Publish your fork to npm under a name you own, then set `hydra_version` to point at your npm tag.
- **Multi-listing.** Not yet in the module — planned. The Hydra CLI supports `publish <cap> <price>` post-init; today this requires one SSH-and-run. Roadmap item: a `variable "extra_capabilities"` that the cloud-init loops through on first boot.

## CI

`.github/workflows/voidly-pay-smoke-tests.yml` runs `terraform fmt -check` + `terraform validate` on every PR that touches `pay-hydra/**`. A typo in `main.tf` fails the check before merge.

## Audit

Full audit of this module's design + failure modes is in the repo at [`docs/voidly-pay-hydra.md`](../../docs/voidly-pay-hydra.md). The commit that fixed the issues surfaced by the v1 audit is tagged with the roadmap items it addresses (3.1 version pin, 3.2 boot health check, 3.3 SSH scoping, 3.4 CI, 3.6 sudo removal, 3.7 image lifecycle, 3.9 Lightsail parity).
