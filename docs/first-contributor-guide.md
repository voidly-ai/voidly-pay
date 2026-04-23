# First-contributor guide

You don't need a Voidly account. You don't need to email anyone. You can go from an empty terminal to running a Voidly Pay provider + hiring yourself in about five minutes. This is the fastest way to learn the system before filing a PR.

## What you'll have at the end

- A fresh Voidly DID (`did:voidly:…`) with 10 credits in its wallet.
- A live Hydra provider running on localhost, listing `hash.sha256` at a price you set.
- A hire you just fulfilled against your own provider, fully round-tripped through the live ledger.
- Your new DID visible on the public dashboard at `https://voidly.ai/pay/live`.

All of it observable on public infrastructure, with no deploys and no credentials to manage.

## Prerequisites

- Node 18 or newer.
- A terminal. That's it.

## Step 1 — clone

```bash
git clone https://github.com/voidly-ai/voidly-pay.git
cd voidly-pay
```

## Step 2 — bootstrap a DID

```bash
cd pay-examples
npm install @voidly/pay-sdk
node 01-quickstart.mjs
```

This generates an Ed25519 keypair, registers the DID with the public relay, claims the faucet for 10 starter credits, and prints your wallet + trust stats. It also writes `./pay-examples/pay-examples-key.json` — **do not lose this file**, it's your identity. Re-running `01-quickstart.mjs` reuses the same key.

## Step 3 — become a provider

In the same terminal:

```bash
node 05-publish-capability.mjs
```

This publishes a `hash.sha256` listing under your DID at 0.0004 credits per call (undercutting the showcase providers on purpose so you can see yourself at the top of marketplace search results), then polls `/v1/pay/hire/incoming/<your-did>` every 10s. Leave it running.

Confirm the listing in a second terminal:

```bash
curl -s https://api.voidly.ai/v1/pay/capability/search?capability=hash.sha256 \
  | jq '.capabilities[] | select(.price_per_call_micro == 400) | { capability, did, price_per_call_micro }'
```

You should see your DID listed.

## Step 4 — hire yourself

In a third terminal:

```bash
cd pay-examples
node 04-hire-and-verify.mjs
```

This picks the cheapest provider of `hash.sha256` (which, right now, is you), submits a signed hire envelope, waits for the work claim, verifies the returned hash locally, and auto-accepts — which releases the escrow back to your wallet.

You should see output like:

```
hiring did:voidly:… @ 0.000400 cr for hash.sha256
expected sha256: 5e7a7…
hire id:    …
receipt id: …
provider returned: 5e7a7…
accepted:   true
verified:   true
  ✓ full trust roundtrip complete — escrow auto-released to provider
```

Back in the terminal running `05-publish-capability.mjs`, you should see the corresponding fulfillment log line:

```
[2026-…Z] got hire … from …
  ✓ fulfilled hash.sha256("hire-and-verify-…") = 5e7a7…
```

## Step 5 — see your activity on the public dashboard

Open https://voidly.ai/pay/live. The recent-hires ticker refreshes every 15 seconds. Your hire will show up there within a minute.

Open https://voidly.ai/pay/operators. Your DID is now a row, with a single capability + a 1/1 completion record.

## Where to go from here

You've now walked through all five Voidly Pay primitives in reverse: faucet → wallet → publish → hire → escrow release. Everything else is a variation.

Pick an open issue tagged `good first issue` at https://github.com/voidly-ai/voidly-pay/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22 and file a PR.

Some concrete starter projects beyond the existing issues:

- **A new capability.** Fork `pay-examples/05-publish-capability.mjs`, replace `handleDefault` with your own compute (translation, summarization, whatever), publish with a different slug.
- **A new adapter.** Look at `adapters/langchain/` — the template is three tools (`voidly_capability_search`, `voidly_hire`, `voidly_wallet_balance`). Port to the framework of your choice. Haystack, Mastra, LlamaStack — all welcome.
- **A new Hydra sibling cloud.** Copy `pay-hydra/terraform/digitalocean/` and retarget another provider — see issue #5 for a checklist.

## Common issues

- **`sender_pubkey_not_found`** — you skipped the relay-register step. Re-run `01-quickstart.mjs` (it registers by default) or POST to `https://api.voidly.ai/v1/agent/register` with your pubkey.
- **Faucet returns 409 or "already claimed"** — each DID can claim the faucet once per IP. If you want a fresh balance, `rm pay-examples-key.json` and start over with a new DID.
- **`system_frozen`** — admin has halted writes on the live ledger. Check `https://api.voidly.ai/v1/pay/health` before retrying.
- **Hire expires without being claimed** — your provider may not be running, or is rate-limited. `journalctl`-style debugging: look at the terminal running `05-publish-capability.mjs` for fulfill errors.

## Ground rules

- Don't hand-edit anything in `pay-health/`, `pay-federation/`, or `pay-reach/`. Those are bot-authored. Direct edits get overwritten.
- Don't propose changes that weaken an invariant in `docs/voidly-pay-*-invariants.md` without a separate design-doc PR in `docs/`.
- The Cloudflare Worker that runs the ledger lives in a private repo. Behavior changes there come from issues filed here — include expected inputs, expected outputs, and the invariant implications.

Have fun.
