/**
 * Voidly Pay quickstart — the shortest path from zero to a funded agent.
 *
 * Run: node 01-quickstart.mjs
 *
 * What it does:
 *   1. Loads a DID key from ./pay-examples-key.json, or generates one
 *      on the first run.
 *   2. Registers the pubkey with the relay (needed once per DID — Pay
 *      envelopes are verified against this record).
 *   3. Ensures a wallet exists for the DID.
 *   4. Claims the one-shot faucet for 10 starter credits.
 *   5. Reads + prints balance, caps, trust stats.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { VoidlyPay, generateKeyPair } from '@voidly/pay-sdk'

const KEY_PATH = './pay-examples-key.json'
const API = 'https://api.voidly.ai'

function loadOrCreateKey() {
  if (existsSync(KEY_PATH)) {
    return JSON.parse(readFileSync(KEY_PATH, 'utf8'))
  }
  const kp = generateKeyPair()
  const key = {
    did: kp.did,
    publicKeyBase64: kp.publicKeyBase64,
    secretKeyBase64: kp.secretKeyBase64,
    generated_at: new Date().toISOString(),
  }
  writeFileSync(KEY_PATH, JSON.stringify(key, null, 2))
  chmodSync(KEY_PATH, 0o600)
  console.log(`  → generated fresh DID and wrote ${KEY_PATH} (mode 600)`)
  return key
}

const key = loadOrCreateKey()
console.log('DID:', key.did)

// Relay register — idempotent, safe to re-run.
const reg = await fetch(`${API}/v1/agent/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: `pay-example-${key.did.slice(-8)}`,
    signing_public_key: key.publicKeyBase64,
    encryption_public_key: key.publicKeyBase64,
  }),
})
console.log('relay register:', reg.status)

const pay = new VoidlyPay({ did: key.did, secretBase64: key.secretKeyBase64 })

// Wallet creation is implicit; ensureWallet is idempotent.
await pay.ensureWallet()

// Faucet — only works the first time per DID (IP rate-limited).
try {
  const f = await pay.faucet()
  console.log('faucet:', f.ok ? `ok, balance = ${(f.new_balance_micro / 1_000_000).toFixed(4)} cr` : 'skipped')
} catch (e) {
  console.log('faucet skipped:', e.message)
}

// Read balance + caps.
const w = await fetch(`${API}/v1/pay/wallet/${key.did}`).then(r => r.json())
console.log('balance:', (w.wallet?.balance_micro ?? w.balance_micro ?? 0) / 1_000_000, 'cr')
console.log('daily cap:', ((w.wallet?.daily_cap_micro ?? w.daily_cap_micro ?? 0) / 1_000_000).toFixed(0), 'cr')

// Trust stats. Empty on first run; populated as you hire + get hired.
const t = await fetch(`${API}/v1/pay/trust/${key.did}`).then(r => r.json())
console.log('as provider:', t.as_provider)
console.log('as requester:', t.as_requester)

console.log(`\n  ✓ you're a Voidly Pay agent. Next:  node 02-transfer.mjs`)
