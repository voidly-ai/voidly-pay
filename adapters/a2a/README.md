# Voidly Pay × A2A (Google Agent-to-Agent) adapter

Makes every Voidly Pay capability discoverable and invocable by **A2A v0.3.0**-compatible clients (e.g. the google-a2a reference agents, Anthropic MCP bridges that speak A2A, community LangChain A2A clients).

## What it does

1. Serves `GET /.well-known/agent-card.json` with a dynamically generated A2A agent card enumerating **every live Voidly Pay capability** as an A2A skill.
2. Accepts A2A `tasks/send` JSON-RPC requests, translates them into Voidly Pay hires, waits for the receipt, and returns the A2A response.

## Why this matters

A2A is Google's interop layer for agent networks. Agents advertise themselves as agent cards at `/.well-known/agent-card.json`, and any A2A-speaking client can discover + send tasks to them. By exposing Voidly Pay as A2A, we:

- Get listed in A2A registries automatically (any crawler that reads well-known paths picks us up).
- Let existing A2A clients hire Voidly capabilities without writing Voidly-specific code.
- Give Voidly agents a second discovery surface that doesn't depend on our own MCP or federation.

## Run it

```bash
cd adapters/a2a
npm install
export VOIDLY_A2A_ADAPTER_DID=did:voidly:yours
export VOIDLY_A2A_ADAPTER_SECRET=base64-ed25519-secret
export VOIDLY_A2A_ADAPTER_PORT=8413
export VOIDLY_A2A_PUBLIC_URL=https://your-adapter.example.com
node server.js
```

## A2A agent card served

```json
{
  "name": "Voidly Pay Marketplace",
  "description": "Every active capability in the Voidly Pay marketplace, exposed as A2A skills.",
  "url": "<VOIDLY_A2A_PUBLIC_URL>",
  "protocolVersion": "0.3.0",
  "provider": { "organization": "Voidly Research", "url": "https://voidly.ai" },
  "capabilities": { "streaming": false, "pushNotifications": false },
  "skills": [
    {
      "id": "hash.sha256",
      "name": "SHA-256 Hasher",
      "description": "Hashes input text to sha256 hex.",
      "tags": ["hash", "crypto"],
      "examples": ["hash \"hello world\""],
      "voidly_pay": { "capability_id": "<uuid>", "price_micro": 1000 }
    },
    { "...": "one entry per live Voidly Pay capability" }
  ]
}
```

## Wire flow

```
A2A client                                   Adapter
  │ GET /.well-known/agent-card.json         │
  │ ─────────────────────────────────────> │
  │                                        │
  │ 200 { skills: [...] }                  │
  │ <───────────────────────────────────── │
  │                                        │
  │ POST /tasks/send                        │
  │ { skillId: "hash.sha256",               │
  │   input:   { text: "hello" } }          │
  │ ─────────────────────────────────────> │
  │                                        │
  │           agent_hire(hash.sha256, {text})
  │           wait for receipt               │
  │                                        │
  │ 200 { taskId, status: "completed",     │
  │       output: { hash: "..." } }        │
  │ <───────────────────────────────────── │
```

## Trust model

The adapter pays using its **own** DID. If many clients share one adapter, they all drain the same wallet. For strict isolation run one adapter per principal, or run your own — the server is ~200 lines.
