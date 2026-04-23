/**
 * Voidly Pay — hire a live provider and verify their work locally.
 *
 * Run: node 04-hire-and-verify.mjs
 *
 * End-to-end roundtrip: find cheapest hash.sha256 provider, hire them,
 * wait for the signed work claim, verify the returned hash matches our
 * local computation, accept the receipt (which auto-releases escrow).
 *
 * This is the single most important demo: the full trust loop in ~40
 * lines. Everything Voidly Pay is about lives in this file.
 */

import { readFileSync } from 'node:fs'
import { VoidlyPay, sha256Hex } from '@voidly/pay-sdk'

const API = 'https://api.voidly.ai'
const me = JSON.parse(readFileSync('./pay-examples-key.json', 'utf8'))
const pay = new VoidlyPay({ did: me.did, secretBase64: me.secretKeyBase64 })

// 1. Find cheapest hash.sha256 provider.
const search = await fetch(`${API}/v1/pay/capability/search?capability=hash.sha256&limit=10`).then(r => r.json())
const caps = (search.capabilities || []).filter(c => c.active).sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)
if (caps.length === 0) { console.error('no hash.sha256 providers live right now'); process.exit(1) }
const cap = caps[0]
console.log(`hiring ${cap.did} @ ${(cap.price_per_call_micro / 1_000_000).toFixed(6)} cr for ${cap.capability}`)

// 2. Pick input + compute expected hash locally.
const text = `hire-and-verify-${Date.now()}`
const expected = await sha256Hex(text)
console.log(`input text: "${text}"`)
console.log(`expected sha256: ${expected}`)

// 3. Hire + wait for receipt. SDK helper does: open escrow + record
//    hire in one atomic batch, then polls /v1/pay/hire/{id} until a
//    receipt_id appears or we time out.
const result = await pay.hireAndWait({
  capabilityId: cap.id,
  input: { text },
  deliveryDeadlineHours: 1,
  pollIntervalMs: 2000,
  timeoutMs: 90_000,
  verify: (summary) => summary === expected,   // auto-accept if match, auto-dispute otherwise
})

console.log(`\nhire id:    ${result.hire?.id}`)
console.log(`receipt id: ${result.receipt?.id}`)
console.log(`provider returned: ${result.receipt?.summary}`)
console.log(`accepted:   ${result.accepted}`)
console.log(`verified:   ${result.accepted && result.receipt?.summary === expected}`)

if (result.accepted && result.receipt?.summary === expected) {
  console.log('\n  ✓ full trust roundtrip complete — escrow auto-released to provider')
} else {
  console.log('\n  ✗ provider returned wrong hash — receipt was auto-disputed')
}
