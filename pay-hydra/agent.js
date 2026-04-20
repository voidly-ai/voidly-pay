#!/usr/bin/env node
/**
 * Voidly Pay Hydra agent — the self-replicating provider pattern.
 *
 * Modes:
 *   - provider  (default): register + faucet (if new) + publish capability
 *                + poll /v1/pay/hire/incoming/<did> + fulfill + claim.
 *   - probe:               register + faucet + search + hire + verify.
 *   - watchdog:            probe every provider once per minute + log failures.
 *
 * Zero shared state. Every Hydra node is independent. The only coupling
 * is the public Voidly Pay ledger (api.voidly.ai).
 *
 * ENV:
 *   VOIDLY_API                  default: https://api.voidly.ai
 *   VOIDLY_HYDRA_DID            required
 *   VOIDLY_HYDRA_KEYFILE        required — path to {did, secretKeyBase64, publicKeyBase64}
 *   VOIDLY_HYDRA_MODE           provider|probe|watchdog (default: provider)
 *   VOIDLY_HYDRA_CAPABILITY     default: echo.lite
 *   VOIDLY_HYDRA_PRICE          default: 0.0005  (credits per call)
 *   VOIDLY_HYDRA_SLA_HOURS      default: 1
 *   VOIDLY_HYDRA_PORT           default: 8420    (HTTP server for the agent card)
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { VoidlyPay } from '@voidly/pay-sdk'

const API        = process.env.VOIDLY_API || 'https://api.voidly.ai'
const MODE       = process.env.VOIDLY_HYDRA_MODE || 'provider'
const CAPABILITY = process.env.VOIDLY_HYDRA_CAPABILITY || 'echo.lite'
const PRICE_CR   = Number(process.env.VOIDLY_HYDRA_PRICE || 0.0005)
const SLA_HOURS  = Number(process.env.VOIDLY_HYDRA_SLA_HOURS || 1)
const PORT       = Number(process.env.VOIDLY_HYDRA_PORT || 8420)
const KEYFILE    = process.env.VOIDLY_HYDRA_KEYFILE
const DID        = process.env.VOIDLY_HYDRA_DID

if (!KEYFILE || !DID) {
  console.error('fatal: VOIDLY_HYDRA_DID and VOIDLY_HYDRA_KEYFILE required')
  process.exit(1)
}

const key = JSON.parse(readFileSync(KEYFILE, 'utf8'))
if (key.did !== DID) {
  console.error(`fatal: keyfile DID (${key.did}) != env DID (${DID})`)
  process.exit(1)
}

const pay = new VoidlyPay({ did: DID, secretBase64: key.secretKeyBase64 })

function log(lvl, msg, extra = null) {
  const rec = { ts: new Date().toISOString(), lvl, msg, mode: MODE, ...(extra || {}) }
  console.log(JSON.stringify(rec))
}

// ── Registration + faucet (safe to re-run) ──────────────────────────────
async function ensureBootstrap() {
  try {
    await fetch(`${API}/v1/agent/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `hydra-${DID.slice(-8)}`,
        signing_public_key: key.publicKeyBase64,
        encryption_public_key: key.publicKeyBase64,
      }),
    }).then(r => r.text())
  } catch (e) {
    log('warn', 'relay register attempt failed (may already exist)', { err: String(e) })
  }

  try {
    await pay.ensureWallet()
  } catch (e) {
    log('warn', 'ensureWallet failed', { err: String(e) })
  }

  try {
    const w = await fetch(`${API}/v1/pay/wallet/${DID}`).then(r => r.json())
    const bal = w?.wallet?.balance_micro ?? w?.balance_micro ?? 0
    if (bal < 1000) {
      const f = await pay.faucet()
      log('info', 'faucet claimed', { ok: f?.ok, new_balance_micro: f?.new_balance_micro })
    } else {
      log('info', 'wallet already funded', { balance_micro: bal })
    }
  } catch (e) {
    log('warn', 'faucet skipped', { err: String(e) })
  }
}

// ── PROVIDER MODE ───────────────────────────────────────────────────────

async function ensureListing() {
  const existing = await fetch(`${API}/v1/pay/capability/did/${DID}`)
    .then(r => r.json()).catch(() => null)
  const already = (existing?.capabilities || []).find(c => c.capability === CAPABILITY && c.active)
  if (already) {
    log('info', 'capability already listed', { id: already.id, price_micro: already.price_per_call_micro })
    return already.id
  }

  const listing = await pay.capabilityList({
    capability: CAPABILITY,
    name: `Hydra ${CAPABILITY}`,
    description: `Voidly Pay Hydra node hosting ${CAPABILITY}. One of many.`,
    price_credits: PRICE_CR,
    unit: 'call',
    sla_deadline_hours: SLA_HOURS,
    tags: ['hydra', 'self-replicating', CAPABILITY.split('.')[0]],
  })
  log('info', 'published capability', { id: listing?.capability?.id, capability: CAPABILITY, price_credits: PRICE_CR })
  return listing?.capability?.id
}

// Implement a small set of safe default capabilities.
function handleDefault(cap, input) {
  const parsed = (typeof input === 'string') ? JSON.parse(input || '{}') : (input || {})
  const text = parsed.text ?? ''
  switch (cap) {
    case 'echo.lite':      return { output: text, timestamp: new Date().toISOString() }
    case 'text.reverse':   return { reversed: String(text).split('').reverse().join('') }
    case 'text.uppercase': return { upper: String(text).toUpperCase() }
    case 'text.length':    return { length: String(text).length }
    case 'hash.sha256':    return { hash: createHash('sha256').update(String(text)).digest('hex') }
    default:               return { error: `unsupported capability '${cap}' on this Hydra node` }
  }
}

async function fulfillOne(hire) {
  try {
    const capSlug = hire.capability
    const output = handleDefault(capSlug, hire.input)
    const workHash = createHash('sha256').update(JSON.stringify(output)).digest('hex')
    await pay.workClaim({
      task_id: hire.task_id || hire.id,
      requester_did: hire.requester_did,
      escrow_id: hire.escrow_id,
      work_hash: capSlug === 'hash.sha256' ? output.hash : workHash,
      summary: capSlug === 'hash.sha256' ? output.hash : JSON.stringify(output),
      acceptance_deadline_hours: 1,
      auto_accept_on_timeout: true,
    })
    log('info', 'fulfilled', { hire_id: hire.id, capability: capSlug })
  } catch (e) {
    log('error', 'fulfill failed', { hire_id: hire.id, err: String(e.message || e) })
  }
}

async function providerLoop() {
  await ensureListing()
  while (true) {
    try {
      const r = await fetch(`${API}/v1/pay/hire/incoming/${DID}?state=requested&limit=20`).then(r => r.json())
      const hires = r?.hires || []
      for (const h of hires) await fulfillOne(h)
    } catch (e) {
      log('error', 'hire poll failed', { err: String(e.message || e) })
    }
    await new Promise(res => setTimeout(res, 10_000))
  }
}

// ── PROBE MODE ──────────────────────────────────────────────────────────

async function probeLoop() {
  while (true) {
    try {
      const r = await fetch(`${API}/v1/pay/capability/search?capability=${CAPABILITY}&limit=10`).then(r => r.json())
      const caps = (r?.capabilities || []).filter(c => c.active).sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)
      const target = caps.find(c => c.did !== DID) // don't hire ourselves
      if (!target) {
        log('info', 'no target')
      } else {
        const text = `hydra-probe-${Date.now()}`
        const { sha256Hex } = await import('@voidly/pay-sdk')
        const expected = await sha256Hex(text)
        const result = await pay.hireAndWait({
          capabilityId: target.id,
          input: { text },
          deliveryDeadlineHours: 1,
          pollIntervalMs: 2500,
          timeoutMs: 60_000,
          verify: CAPABILITY === 'hash.sha256' ? (s) => s === expected : undefined,
        })
        log('info', 'probe cycle', { target_did: target.did, accepted: !!result.accepted, state: result.receipt?.state })
      }
    } catch (e) {
      log('error', 'probe cycle failed', { err: String(e.message || e) })
    }
    await new Promise(res => setTimeout(res, 5 * 60_000))
  }
}

// ── WATCHDOG MODE ───────────────────────────────────────────────────────

async function watchdogLoop() {
  while (true) {
    try {
      const caps = (await fetch(`${API}/v1/pay/capability/search?limit=200`).then(r => r.json()))?.capabilities || []
      const byDid = new Map()
      for (const c of caps) { if (!byDid.has(c.did)) byDid.set(c.did, []); byDid.get(c.did).push(c) }
      byDid.delete(DID)
      let ok = 0, fail = 0
      for (const [did, list] of byDid.entries()) {
        const pick = list.find(c => c.capability === 'hash.sha256') || list.find(c => !c.capability.startsWith('llm.'))
        if (!pick) continue
        try {
          const t0 = Date.now()
          const result = await pay.hireAndWait({
            capabilityId: pick.id,
            input: { text: `watchdog-${Date.now()}` },
            deliveryDeadlineHours: 1,
            pollIntervalMs: 2500,
            timeoutMs: 45_000,
          })
          log('info', 'probe', { did, capability: pick.capability, accepted: !!result.accepted, latency_ms: Date.now() - t0 })
          ok++
        } catch (e) {
          log('warn', 'probe failed', { did, capability: pick.capability, err: String(e.message || e) })
          fail++
        }
      }
      log('info', 'watchdog cycle', { ok, fail })
    } catch (e) {
      log('error', 'watchdog cycle failed', { err: String(e.message || e) })
    }
    await new Promise(res => setTimeout(res, 60_000))
  }
}

// ── HTTP server — expose an agent card ─────────────────────────────────
function startAgentCardServer() {
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    const url = (req.url || '/').split('?')[0]
    if (url === '/.well-known/agent-card.json') {
      const ourCaps = await fetch(`${API}/v1/pay/capability/did/${DID}`)
        .then(r => r.json()).catch(() => ({ capabilities: [] }))
      const card = {
        name: `Voidly Pay Hydra ${DID.slice(-8)}`,
        description: 'Self-registered Voidly Pay Hydra provider.',
        url: `http://0.0.0.0:${PORT}`,
        protocolVersion: '0.3.0',
        provider: { organization: 'Voidly Pay Hydra', url: 'https://voidly.ai/pay' },
        skills: (ourCaps?.capabilities || []).map(c => ({
          id: c.capability,
          name: c.name,
          tags: ['hydra', c.capability.split('.')[0]],
          voidly_pay: { capability_id: c.id, price_micro: c.price_per_call_micro, did: DID },
        })),
        voidly_pay: {
          did: DID,
          pay_manifest_url: `${API}/v1/pay/manifest.json`,
          federation_url: 'https://voidly.ai/pay/federation',
        },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(card, null, 2))
    } else if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, did: DID, mode: MODE }))
    } else {
      res.writeHead(404); res.end('not found')
    }
  })
  server.listen(PORT, () => log('info', 'agent card server listening', { port: PORT }))
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  log('info', 'hydra boot', { did: DID, mode: MODE, capability: CAPABILITY, price_cr: PRICE_CR })
  await ensureBootstrap()
  startAgentCardServer()
  if (MODE === 'provider')  await providerLoop()
  else if (MODE === 'probe')    await probeLoop()
  else if (MODE === 'watchdog') await watchdogLoop()
  else { log('error', 'unknown mode', { mode: MODE }); process.exit(1) }
}

main().catch(e => { log('error', 'hydra crash', { err: String(e.message || e) }); process.exit(1) })
