# @voidly/pay-mcp

MCP server exposing **Voidly Pay** primitives to Claude Code, Cursor, Windsurf, and any MCP-compatible client. 27 tools across wallet, transfer, batch, escrow, streams, subscriptions, x402 (server + client), webhooks, and observability.

## Install (one line)

Add to your client's MCP config (Claude Code's `.mcp.json`, Cursor's `~/.cursor/mcp.json`, Windsurf's `~/.codeium/windsurf/mcp_config.json`, etc.):

```json
{
  "mcpServers": {
    "voidly-pay": {
      "command": "npx",
      "args": ["-y", "@voidly/pay-mcp"]
    }
  }
}
```

On first run the server mints + persists an Ed25519 keypair to `~/.voidly-pay/keypair.json` (mode 0600). The DID derived from that key is your agent's identity.

## What you can do (27 tools)

```
# Wallet
agent_pay_self                    Show this agent's DID, pubkey, balance.
agent_wallet_balance              Read any wallet (defaults to self).
agent_wallet_ensure               Idempotent wallet creation.

# Transfers
agent_pay                         Send N credits to a DID.
agent_pay_batch                   Multi-recipient atomic transfer (≤100).
agent_pay_get                     Look up a transfer by id.
agent_payment_history             Paginated history.

# Escrow
agent_escrow_open / release / refund

# Streams (per-token billing)
agent_stream_open / meter / finalize

# Subscriptions (recurring)
agent_subscribe / agent_subscription_cancel

# x402 (server + client)
agent_x402_quote                  Server: issue a 402 quote.
agent_x402_verify                 Server: verify + consume X-Payment.
agent_x402_fetch                  Client: pay-on-402, returns final response.

# Webhooks
agent_webhook_subscribe / agent_webhook_delete

# Observability (read-only)
agent_pay_health / manifest / stats / activity / leaderboard / feed / trust
```

## Configuration

Environment variables (set in your MCP client config under `env`):

```json
{
  "mcpServers": {
    "voidly-pay": {
      "command": "npx",
      "args": ["-y", "@voidly/pay-mcp"],
      "env": {
        "VOIDLY_PAY_API_URL": "https://api.voidly.ai"
      }
    }
  }
}
```

Or pass `--api-url <url>` as a CLI arg.

## First-run quickstart

1. Add the config above and restart your MCP client.
2. The server prints your DID to stderr on startup. Copy it.
3. In a chat, ask: "Use voidly-pay to claim a sandbox wallet for me".
4. The tool registers a 1,000-credit test wallet via `POST /v1/pay/test/wallet/create`.
5. Now ask: "Send 0.1 credits to did:voidly:example".

## License

MIT
