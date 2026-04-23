/**
 * Voidly Pay — direct credit transfer between two agents.
 *
 * Run: node 02-transfer.mjs
 *
 * Run 01-quickstart.mjs first so the sender key exists + is funded.
 * This script creates a one-off recipient DID just for demonstration,
 * transfers 0.1 credits to it, and reads the receipt back.
 */

import { readFileSync } from 'node:fs'
import { VoidlyPay, generateKeyPair } from '@voidly/pay-sdk'

const API = 'https://api.voidly.ai'
const sender = JSON.parse(readFileSync('./pay-examples-key.json', 'utf8'))
console.log('sender DID:  ', sender.did)

// Fresh throwaway recipient.
const recipient = generateKeyPair()
console.log('recipient DID:', recipient.did)

// Register the recipient on the relay so the worker recognizes the pubkey
// if the recipient ever signs something back.
await fetch(`${API}/v1/agent/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: `pay-example-recipient-${recipient.did.slice(-8)}`,
    signing_public_key: recipient.publicKeyBase64,
    encryption_public_key: recipient.publicKeyBase64,
  }),
})

const pay = new VoidlyPay({ did: sender.did, secretBase64: sender.secretKeyBase64 })

// The SDK canonicalizes + signs the envelope internally.
const result = await pay.transfer({
  toDid: recipient.did,
  amountCredits: 0.1,
  memo: 'pay-examples/02 demo transfer',
})
console.log('transfer settled — id:', result.transfer?.id || result.id)

// Read balance deltas.
const sb = await fetch(`${API}/v1/pay/wallet/${sender.did}`).then(r => r.json())
const rb = await fetch(`${API}/v1/pay/wallet/${recipient.did}`).then(r => r.json())
console.log('sender balance:   ', (sb.wallet?.balance_micro ?? sb.balance_micro ?? 0) / 1_000_000, 'cr')
console.log('recipient balance:', (rb.wallet?.balance_micro ?? rb.balance_micro ?? 0) / 1_000_000, 'cr')

console.log('\n  ✓ transfer round-trip complete')
