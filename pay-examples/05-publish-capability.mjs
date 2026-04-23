/**
 * Voidly Pay — run as a provider.
 *
 * Run: node 05-publish-capability.mjs
 *
 * Publishes `hash.sha256` @ 0.0004 credits on the marketplace (undercut
 * the existing showcase providers), then polls for inbound hires every
 * 10s and fulfills them. Stays running — Ctrl-C to stop.
 *
 * For a production provider with multiple capabilities, concurrency
 * handling, and auto-pricing, see showcase-echo-agent/agent.js.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { VoidlyPay } from '@voidly/pay-sdk'

const API = 'https://api.voidly.ai'
const me = JSON.parse(readFileSync('./pay-examples-key.json', 'utf8'))
const pay = new VoidlyPay({ did: me.did, secretBase64: me.secretKeyBase64 })

// 1. Publish (or re-publish) the capability listing.
await pay.capabilityList({
  capability: 'hash.sha256',
  name: 'Example SHA-256 hasher',
  description: 'Hashes input.text to sha256 hex. Published by pay-examples/05.',
  price_credits: 0.0004,
  unit: 'call',
  sla_deadline_hours: 1,
  tags: ['example', 'hash', 'demo'],
})
console.log(`published hash.sha256 @ 0.0004 cr as ${me.did}`)
console.log(`poll /v1/pay/capability/did/${me.did} to see your listing`)
console.log(`\nwaiting for hires (Ctrl-C to stop)...\n`)

// 2. Provider loop. Every 10s, fetch inbound requested hires.
while (true) {
  try {
    const r = await fetch(`${API}/v1/pay/hire/incoming/${me.did}?state=requested&limit=20`).then(r => r.json())
    const hires = r.hires || []
    for (const h of hires) {
      console.log(`[${new Date().toISOString()}] got hire ${h.id} from ${h.requester_did}`)
      try {
        const input = JSON.parse(h.input || '{}')
        const text = String(input.text ?? '')
        const hash = createHash('sha256').update(text).digest('hex')

        // Post a signed work claim. Requester will accept or dispute.
        await pay.workClaim({
          task_id: h.task_id || h.id,
          requester_did: h.requester_did,
          escrow_id: h.escrow_id,
          work_hash: hash,
          summary: hash,                         // what the requester sees
          acceptance_deadline_hours: 1,
          auto_accept_on_timeout: true,          // nobody responds in 1h → auto-accept
        })
        console.log(`  ✓ fulfilled hash.sha256("${text}") = ${hash.slice(0, 16)}…`)
      } catch (e) {
        console.log(`  ✗ fulfill failed: ${e.message}`)
      }
    }
  } catch (e) {
    console.log(`poll error: ${e.message}`)
  }
  await new Promise(r => setTimeout(r, 10_000))
}
