# Voidly Pay × x402 adapter

Exposes Voidly Pay capabilities over the **x402** payment-required HTTP protocol. Any x402-speaking client can hit these endpoints, receive the 402 challenge, pay via Voidly, retry with the proof, and get the capability's output — all over plain HTTP, no SDK required on the client side.

## Why

x402 is emerging as the "HTTP-native micro-payments" spec (originally popularized by Coinbase/Circle for stablecoin payments on the open web). By speaking x402 over Voidly's credit ledger, we bridge every x402 client into our marketplace without them having to know anything Voidly-specific.

This adapter is a reference server. It does **not** require a Voidly Pay worker deploy; it runs locally (or on any VM) and uses the public Voidly Pay API.

## Wire flow

```
Client                                   Adapter
  │ GET /x402/hash.sha256?text=hi          │
  │ ─────────────────────────────────────> │
  │                                        │
  │ 402 Payment Required                   │
  │   x-payment-required: voidly-pay       │
  │   x-payment-amount:   0.0008           │
  │   x-payment-capability-id: <uuid>      │
  │   x-payment-nonce: <uuid>              │
  │ <───────────────────────────────────── │
  │                                        │
  │ Client signs a Voidly Pay hire         │
  │ envelope using its did:voidly:... key. │
  │                                        │
  │ GET /x402/hash.sha256?text=hi          │
  │   x-payment-proof: <base64 envelope>   │
  │   x-payment-signature: <base64 ed25519>│
  │ ─────────────────────────────────────> │
  │                                        │
  │ Adapter POSTs /v1/pay/hire on          │
  │ client's behalf, awaits receipt, and   │
  │ returns the capability output.         │
  │                                        │
  │ 200 OK                                 │
  │   x-payment-settled: <receipt-id>      │
  │ <───────────────────────────────────── │
```

## Run it

```bash
cd adapters/x402
npm install
export VOIDLY_X402_ADAPTER_PORT=8412
node server.js
```

The adapter is **stateless** — it doesn't hold funds of its own. Each 402-cycle is paid for by the client's wallet; the adapter just relays the hire to Voidly Pay on the client's behalf. This means:

- The adapter operator never has custody of anyone's credits.
- The client's DID is the one charged.
- The receipt is signed by the capability provider (not the adapter).

## Example client (Node)

```js
import { VoidlyPay } from '@voidly/pay-sdk'

const pay = new VoidlyPay({ did: process.env.DID, signingSecretKey: process.env.SECRET })

// First hit: get the 402
let res = await fetch('http://localhost:8412/x402/hash.sha256?text=hi')
if (res.status !== 402) throw new Error('expected 402')
const capId = res.headers.get('x-payment-capability-id')
const nonce = res.headers.get('x-payment-nonce')

// Build + sign a hire envelope using pay-sdk's canonicalizer
const envelope = await pay.buildHireEnvelope({
  capability_id: capId,
  input: JSON.stringify({ text: 'hi' }),
  nonce,
  delivery_deadline_hours: 1,
})
const signature = pay.signEnvelope(envelope)

// Retry with payment proof
res = await fetch('http://localhost:8412/x402/hash.sha256?text=hi', {
  headers: {
    'x-payment-proof': Buffer.from(JSON.stringify(envelope)).toString('base64'),
    'x-payment-signature': signature,
  },
})
console.log(await res.text())
```

## Compatibility claims

- Speaks x402/0.1 challenge-response. Uses custom headers prefixed `x-payment-*` so any HTTP client (curl, fetch, requests) can participate without a special library.
- The proof envelope is a Voidly Pay `voidly-pay-hire/v1` envelope — the same format `agent_hire` uses. So a client that can sign for the Voidly ledger can transact here with zero protocol learning.
- The adapter **does not accept fiat or stablecoins**. x402 typically implies USDC settlement; this adapter is the Voidly-credit variant. Stage 2 of Voidly Pay migrates the ledger to USDC on Base without changing the envelope format, at which point this adapter's flow is unchanged but the settlement currency is real.

## Caveats

- Long-running capabilities: the adapter waits up to 60 s for a receipt before returning. For longer jobs, use the Voidly Pay API directly — 402 is a poor fit for long-polling.
- No streaming. One call, one response.
- Replay protection is enforced by the Voidly ledger (nonces must be unique per-DID). The adapter doesn't add its own.
