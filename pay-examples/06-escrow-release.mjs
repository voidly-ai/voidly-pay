/**
 * Voidly Pay — explicit escrow flow (open → release).
 *
 * Run: node 06-escrow-release.mjs
 *
 * Most of the time you don't call escrow directly — `agent_hire` opens
 * one for you in the same atomic batch as the hire record. This script
 * demonstrates the lower-level flow for the cases where you need
 * manual control: locking credits before a task is scoped, running
 * a bounty, or any workflow where escrow outlives the marketplace
 * primitive.
 *
 * Creates a throwaway recipient, opens an escrow for 0.5 credits with
 * a 1h deadline, then releases it explicitly after a short pause.
 */

import { readFileSync } from 'node:fs'
import { VoidlyPay, generateKeyPair } from '@voidly/pay-sdk'

const API = 'https://api.voidly.ai'
const me = JSON.parse(readFileSync('./pay-examples-key.json', 'utf8'))
const pay = new VoidlyPay({ did: me.did, secretBase64: me.secretKeyBase64 })

// Register a throwaway recipient.
const recipient = generateKeyPair()
await fetch(`${API}/v1/agent/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: `pay-example-escrow-recipient-${recipient.did.slice(-8)}`,
    signing_public_key: recipient.publicKeyBase64,
    encryption_public_key: recipient.publicKeyBase64,
  }),
})
console.log('recipient DID:', recipient.did)

// Open escrow — 0.5 cr, 1h deadline, auto-refunds if not released.
const open = await pay.escrowOpen({
  toDid: recipient.did,
  amountCredits: 0.5,
  deadlineHours: 1,
})
const escrowId = open.escrow?.id || open.id
console.log(`escrow opened: ${escrowId}`)
console.log(`  state: open, amount: 0.5 cr, deadline: +1h`)

// Read the escrow back.
let e = await fetch(`${API}/v1/pay/escrow/${escrowId}`).then(r => r.json())
console.log(`  confirmed state: ${e.escrow?.state || e.state}`)

// Pause briefly for readability.
await new Promise(r => setTimeout(r, 1500))

// Release.
await pay.escrowRelease({ escrow_id: escrowId })
console.log(`escrow released to ${recipient.did}`)

// Read final state.
e = await fetch(`${API}/v1/pay/escrow/${escrowId}`).then(r => r.json())
console.log(`  final state: ${e.escrow?.state || e.state}`)

const rb = await fetch(`${API}/v1/pay/wallet/${recipient.did}`).then(r => r.json())
console.log(`  recipient balance: ${(rb.wallet?.balance_micro ?? rb.balance_micro ?? 0) / 1_000_000} cr`)

console.log('\n  ✓ open → release flow complete')
console.log('    (for open → refund, sign escrowRefund instead of escrowRelease)')
