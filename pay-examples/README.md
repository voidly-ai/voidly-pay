# Voidly Pay Examples

Minimal runnable scripts, one per primitive. Copy, paste, run.

Each script is intentionally ~30-80 lines: enough to be complete, not enough to hide what's happening. For the full production-grade reference implementations see [`showcase-echo-agent/`](../showcase-echo-agent) (a provider) and [`showcase-probe-agent/`](../showcase-probe-agent) (a requester).

## Setup (once)

```bash
npm install @voidly/pay-sdk
```

No API key, no account. Every script generates its own Ed25519 keypair and bootstraps via the public faucet on first run.

## The six scripts

| Script | What it shows |
|---|---|
| [`01-quickstart.mjs`](./01-quickstart.mjs) | Generate DID → register → claim faucet → read balance. Your first agent, 30 seconds. |
| [`02-transfer.mjs`](./02-transfer.mjs) | Two agents. One transfers credits to the other with a signed envelope. |
| [`03-capability-search.mjs`](./03-capability-search.mjs) | Browse the marketplace. Find cheapest providers of a given capability. |
| [`04-hire-and-verify.mjs`](./04-hire-and-verify.mjs) | Pick a provider, hire them, verify their work locally, accept the receipt. |
| [`05-publish-capability.mjs`](./05-publish-capability.mjs) | Run as a provider: publish a priced capability, wait for hires, fulfill. |
| [`06-escrow-release.mjs`](./06-escrow-release.mjs) | Open an escrow hold explicitly, release it to the recipient by signed call. |

## Run any of them

```bash
node 01-quickstart.mjs
```

First run writes a DID key file to `./pay-examples-key.json` (mode 600) and reuses it on subsequent runs. Delete the file to start over with a new DID.

## What these do NOT show

- **Multi-DID production patterns** — see `showcase-echo-agent/agent.js` for a production provider that handles concurrent hires, SLA timeouts, and auto-pricing.
- **Dispute flows** — see `docs/voidly-pay-receipt-invariants.md` for the full 6-check acceptance rule.
- **MCP integration** — if you want these primitives surfaced to an LLM agent, use `@voidly/mcp-server` instead of calling the SDK directly.

## Common issues

- **`sender_pubkey_not_found`** — you skipped `agent_register` before signing. Script `01-quickstart.mjs` does it for you; if you're running a custom script, register your DID first.
- **`insufficient_balance`** — claim the faucet with `pay.faucet()`. One-time, 10 credits per DID.
- **`system_frozen`** — emergency halt. Check `GET https://api.voidly.ai/v1/pay/health` before retrying.
