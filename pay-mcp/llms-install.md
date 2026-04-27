# llms-install.md — for Cline / agent installers

This file gives a coding-agent (Cline, Cursor, etc.) the minimum it needs to install `@voidly/pay-mcp` cleanly. Humans can ignore this and read `README.md`.

## Prerequisites

- Node.js 18+ (the package will spawn `npx -y @voidly/pay-mcp` on first use; `npx` is bundled with Node).
- No API key, no signup, no environment variables required for default operation.
- The first run mints a fresh Ed25519 keypair to `~/.voidly-pay/keypair.json` (mode 0600) and uses that DID as the agent's identity.

## Install — single MCP config block

Add this block to the user's MCP server config (Claude Desktop's `claude_desktop_config.json`, Cline's `.mcp.json`, Cursor's `~/.cursor/mcp.json`, Windsurf's `~/.codeium/windsurf/mcp_config.json`, etc.):

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

That is the entire installation. Reload the MCP host and the 28 Voidly Pay tools (agent_pay, agent_x402_quote, agent_escrow_open, agent_stream_open, etc.) will be exposed.

## Optional environment variables

Only needed if the user wants to override defaults:

- `VOIDLY_PAY_API_URL` — defaults to `https://api.voidly.ai`. Override to point at a self-hosted facilitator.
- `VOIDLY_PAY_KEYFILE` — defaults to `~/.voidly-pay/keypair.json`. Override to use a different key.
- `VOIDLY_PAY_DID` — defaults to deriving from the keyfile. Override to pin a specific DID.

Set them under `env` in the MCP server config:

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

## Verify the install

After reload, ask the host:

> "Use the voidly-pay MCP server to call `agent_pay_self` and tell me my DID."

Expected: a `did:voidly:<22 chars>` string and a wallet balance. The first call may take a few seconds while `npx` resolves the package.

## Bootstrap credits (one-time, optional)

To do real settlements, the agent needs credits. The server exposes `agent_faucet` which signs a one-shot envelope and grants 10 starter credits per DID. Call it once after install:

> "Call `agent_faucet` to claim 10 starter credits."

After that the agent can transfer, escrow, hire other agents, and pay HTTP 402 endpoints.

## Safety

- Private keys never leave the user's machine — the keyfile is created locally with mode 0600.
- All envelopes are signed client-side. The Voidly facilitator only verifies signatures + atomically settles balances; it cannot forge transactions on the user's behalf.
- Stage 2 backing: every credit on the rail is backed 1:1 by USDC in a vault on Base mainnet. Public reserves dashboard: https://voidly.ai/pay/proof
- Source verification: https://repo.sourcify.dev/contracts/full_match/8453/0xb592512932a7b354969bb48039c2dc7ad6ad1c12/

## Uninstall

Remove the `voidly-pay` block from the MCP config and (optionally) delete `~/.voidly-pay/keypair.json`. No daemons, no global state.
