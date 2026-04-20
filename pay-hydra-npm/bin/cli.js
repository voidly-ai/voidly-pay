#!/usr/bin/env node
/**
 * @voidly/pay-hydra CLI
 *
 * Zero-install bootstrap of a Voidly Pay provider:
 *
 *   npx @voidly/pay-hydra init              # first-time: new DID + faucet + publish + run
 *   npx @voidly/pay-hydra run               # re-use existing DID, run provider loop
 *   npx @voidly/pay-hydra status            # print our wallet + listings
 *   npx @voidly/pay-hydra delist <cap>      # deactivate one capability
 *   npx @voidly/pay-hydra publish <cap> <price>  # publish another capability
 *
 * All state lives in ~/.voidly-hydra/ (or $HYDRA_HOME). No global config.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { VoidlyPay, generateKeyPair, sha256Hex } from '@voidly/pay-sdk'

const API = process.env.VOIDLY_API || 'https://api.voidly.ai'
const HYDRA_HOME = process.env.HYDRA_HOME || join(homedir(), '.voidly-hydra')
const KEY_PATH = join(HYDRA_HOME, 'keys', 'active.json')

const args = process.argv.slice(2)
const cmd = args[0] || 'help'

function log(lvl, msg, extra) {
  const rec = { ts: new Date().toISOString(), lvl, msg, ...(extra || {}) }
  process.stdout.write(JSON.stringify(rec) + '\n')
}

function loadKey() {
  if (!existsSync(KEY_PATH)) {
    console.error(`no key found at ${KEY_PATH}. Run 'npx @voidly/pay-hydra init' first.`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(KEY_PATH, 'utf8'))
}

async function relayRegister(kp, name) {
  try {
    const r = await fetch(`${API}/v1/agent/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name || `hydra-${kp.did.slice(-8)}`,
        signing_public_key: kp.publicKeyBase64,
        encryption_public_key: kp.publicKeyBase64,
      }),
    })
    return { status: r.status }
  } catch (e) {
    return { error: String(e) }
  }
}

// ── init ────────────────────────────────────────────────────────────────
async function cmdInit() {
  // Prefer CLI flags; fall back to env vars so Docker + Helm deployments
  // that only have env (not argv) still work. Final fallback: hardcoded
  // defaults.
  const capability = getFlag('--capability') || process.env.HYDRA_CAPABILITY     || 'echo.lite'
  const priceCr    = Number(getFlag('--price')  || process.env.HYDRA_PRICE_CREDITS || 0.0005)
  const slaHours   = Number(getFlag('--sla-hours') || process.env.HYDRA_SLA_HOURS || 1)
  const name       = getFlag('--name') || process.env.HYDRA_NAME || null

  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 })
  chmodSync(dirname(KEY_PATH), 0o700)

  let keyData
  if (existsSync(KEY_PATH)) {
    keyData = JSON.parse(readFileSync(KEY_PATH, 'utf8'))
    log('info', 're-using existing DID', { did: keyData.did })
  } else {
    const kp = generateKeyPair()
    keyData = {
      did: kp.did,
      publicKeyBase64: kp.publicKeyBase64,
      secretKeyBase64: kp.secretKeyBase64,
      generated_at: new Date().toISOString(),
    }
    writeFileSync(KEY_PATH, JSON.stringify(keyData, null, 2), { mode: 0o600 })
    chmodSync(KEY_PATH, 0o600)
    log('info', 'generated fresh DID', { did: keyData.did })
  }

  // Register + faucet
  const reg = await relayRegister(keyData, name)
  log('info', 'relay register', reg)

  const pay = new VoidlyPay({ did: keyData.did, secretBase64: keyData.secretKeyBase64 })
  try { await pay.ensureWallet() } catch {}
  try {
    const f = await pay.faucet()
    log('info', 'faucet', { ok: f?.ok, new_balance_micro: f?.new_balance_micro })
  } catch (e) {
    log('warn', 'faucet skipped (already claimed?)', { err: String(e.message || e) })
  }

  // Publish capability if not already listed
  const existing = await fetch(`${API}/v1/pay/capability/did/${keyData.did}`)
    .then(r => r.json()).catch(() => null)
  const already = (existing?.capabilities || []).find(c => c.capability === capability && c.active)
  if (already) {
    log('info', 'capability already listed', { id: already.id, price_micro: already.price_per_call_micro })
  } else {
    try {
      const l = await pay.capabilityList({
        capability,
        name: `Hydra ${capability}`,
        description: `Voidly Pay Hydra node hosting ${capability}. One of many.`,
        price_credits: priceCr,
        unit: 'call',
        sla_deadline_hours: slaHours,
        tags: ['hydra', 'self-replicating', capability.split('.')[0]],
      })
      log('info', 'capability published', { id: l?.capability?.id, capability, price_credits: priceCr })
    } catch (e) {
      log('error', 'publish failed', { err: String(e.message || e) })
    }
  }

  console.log('')
  console.log('  ✓ Hydra node initialized')
  console.log('    DID: ' + keyData.did)
  console.log('    Key: ' + KEY_PATH + ' (600)')
  console.log('')
  console.log('  Next:  npx @voidly/pay-hydra run    # start the provider loop')
  console.log('         npx @voidly/pay-hydra status')
  console.log('')
}

// ── run ─────────────────────────────────────────────────────────────────
async function cmdRun() {
  const keyData = loadKey()
  const pay = new VoidlyPay({ did: keyData.did, secretBase64: keyData.secretKeyBase64 })
  const port = Number(getFlag('--port') || process.env.VOIDLY_HYDRA_PORT || process.env.HYDRA_PORT || 8420)

  // externalUrl baked into the agent card so federation crawlers /
  // A2A clients can actually call us back. In k8s the chart injects
  // HYDRA_EXTERNAL_URL from the ingress host; in bare-metal / docker
  // set it yourself, or leave empty and the card reports the listen
  // socket (useful only for localhost debugging).
  const externalUrl = getFlag('--external-url')
    || process.env.HYDRA_EXTERNAL_URL
    || `http://0.0.0.0:${port}`

  log('info', 'hydra boot', { did: keyData.did, port, external_url: externalUrl })

  // Simple HTTP agent-card server
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    const url = (req.url || '/').split('?')[0]
    if (url === '/.well-known/agent-card.json') {
      const caps = await fetch(`${API}/v1/pay/capability/did/${keyData.did}`).then(r => r.json()).catch(() => ({ capabilities: [] }))
      const card = {
        name: `Voidly Pay Hydra ${keyData.did.slice(-8)}`,
        description: 'Self-registered Voidly Pay Hydra provider.',
        url: externalUrl,
        protocolVersion: '0.3.0',
        provider: { organization: 'Voidly Pay Hydra', url: 'https://voidly.ai/pay/federation' },
        skills: (caps?.capabilities || []).map(c => ({
          id: c.capability, name: c.name,
          tags: ['hydra', c.capability.split('.')[0]],
          voidly_pay: { capability_id: c.id, price_micro: c.price_per_call_micro, did: keyData.did },
        })),
        voidly_pay: { did: keyData.did, pay_manifest_url: `${API}/v1/pay/manifest.json` },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(card, null, 2))
    } else if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, did: keyData.did }))
    } else {
      res.writeHead(404); res.end('not found')
    }
  })
  server.listen(port, () => log('info', 'agent-card server listening', { port }))

  // Provider loop
  while (true) {
    try {
      const r = await fetch(`${API}/v1/pay/hire/incoming/${keyData.did}?state=requested&limit=20`).then(r => r.json())
      for (const h of (r?.hires || [])) {
        try {
          const output = handleDefault(h.capability, h.input)
          const workHash = h.capability === 'hash.sha256' && output.hash
            ? output.hash
            : createHash('sha256').update(JSON.stringify(output)).digest('hex')
          const summary = h.capability === 'hash.sha256' ? output.hash : JSON.stringify(output)
          await pay.workClaim({
            task_id: h.task_id || h.id,
            requester_did: h.requester_did,
            escrow_id: h.escrow_id,
            work_hash: workHash,
            summary,
            acceptance_deadline_hours: 1,
            auto_accept_on_timeout: true,
          })
          log('info', 'fulfilled', { hire_id: h.id, capability: h.capability })
        } catch (e) {
          log('error', 'fulfill failed', { hire_id: h.id, err: String(e.message || e) })
        }
      }
    } catch (e) {
      log('error', 'poll failed', { err: String(e.message || e) })
    }
    await new Promise(res => setTimeout(res, 10_000))
  }
}

// ── status ──────────────────────────────────────────────────────────────
async function cmdStatus() {
  const keyData = loadKey()
  try {
    const w = await fetch(`${API}/v1/pay/wallet/${keyData.did}`).then(r => r.json())
    const t = await fetch(`${API}/v1/pay/trust/${keyData.did}`).then(r => r.json())
    const c = await fetch(`${API}/v1/pay/capability/did/${keyData.did}`).then(r => r.json())
    console.log('DID:', keyData.did)
    console.log('Balance:', ((w?.wallet?.balance_micro ?? w?.balance_micro ?? 0) / 1_000_000).toFixed(6), 'cr')
    console.log('Frozen:', !!(w?.wallet?.frozen ?? w?.frozen))
    if (t?.as_provider) {
      console.log('As provider — completed:', t.as_provider.total_completed, ' earned:', (t.as_provider.total_earned_micro / 1_000_000).toFixed(6), 'cr')
    }
    console.log('Capabilities:')
    for (const cap of (c?.capabilities || [])) {
      console.log(`  - ${cap.capability.padEnd(24)} ${(cap.price_per_call_micro / 1_000_000).toFixed(4)} cr  ${cap.active ? 'active' : 'INACTIVE'}  ${cap.total_completed}/${cap.total_hires} done`)
    }
  } catch (e) {
    console.error('status failed:', e.message || e)
    process.exit(1)
  }
}

// ── publish ─────────────────────────────────────────────────────────────
async function cmdPublish() {
  const keyData = loadKey()
  const capability = args[1]
  const priceCr = Number(args[2] || 0.0005)
  if (!capability) { console.error('usage: publish <capability-slug> <price-credits>'); process.exit(1) }
  const pay = new VoidlyPay({ did: keyData.did, secretBase64: keyData.secretKeyBase64 })
  const l = await pay.capabilityList({
    capability, name: `Hydra ${capability}`,
    description: `Hydra node hosting ${capability}.`,
    price_credits: priceCr, unit: 'call', sla_deadline_hours: 1,
    tags: ['hydra', capability.split('.')[0]],
  })
  console.log('published:', l?.capability?.id, capability, '@', priceCr, 'cr')
}

// ── delist ──────────────────────────────────────────────────────────────
async function cmdDelist() {
  const keyData = loadKey()
  const slug = args[1]
  if (!slug) { console.error('usage: delist <capability-slug>'); process.exit(1) }
  const pay = new VoidlyPay({ did: keyData.did, secretBase64: keyData.secretKeyBase64 })
  const c = await fetch(`${API}/v1/pay/capability/did/${keyData.did}`).then(r => r.json())
  const target = (c?.capabilities || []).find(x => x.capability === slug && x.active)
  if (!target) { console.error('no active listing for', slug); process.exit(1) }
  await pay.capabilityList({
    capability: slug, name: target.name, description: target.description || '',
    price_credits: target.price_per_call_micro / 1_000_000, unit: target.unit,
    sla_deadline_hours: target.sla_deadline_hours, tags: ['delisted'], active: false,
  })
  console.log('delisted:', slug)
}

// ── in-process default capabilities ─────────────────────────────────────
function handleDefault(cap, input) {
  const parsed = (typeof input === 'string') ? JSON.parse(input || '{}') : (input || {})
  const text = String(parsed.text ?? '')
  switch (cap) {
    case 'echo.lite':      return { output: text, timestamp: new Date().toISOString() }
    case 'text.reverse':   return { reversed: text.split('').reverse().join('') }
    case 'text.uppercase': return { upper: text.toUpperCase() }
    case 'text.length':    return { length: text.length }
    case 'hash.sha256':    return { hash: createHash('sha256').update(text).digest('hex') }
    default:               return { error: `unsupported capability '${cap}' on this Hydra node` }
  }
}

function getFlag(name) {
  const i = args.indexOf(name)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  const eq = args.find(a => a.startsWith(name + '='))
  if (eq) return eq.slice(name.length + 1)
  return null
}

// ── Dispatch ────────────────────────────────────────────────────────────
function help() {
  console.log('Usage: npx @voidly/pay-hydra <command>')
  console.log('')
  console.log('Commands:')
  console.log('  init                          First-time bootstrap (new DID + faucet + publish)')
  console.log('  run                           Run the provider loop (after init)')
  console.log('  status                        Show wallet + listings + trust stats')
  console.log('  publish <cap> <price>         Publish another capability')
  console.log('  delist  <cap>                 Deactivate a capability')
  console.log('')
  console.log('Flags for init:')
  console.log('  --capability=<slug>           (default: echo.lite)')
  console.log('  --price=<credits>             (default: 0.0005)')
  console.log('  --sla-hours=<n>               (default: 1)')
  console.log('  --name=<string>               Display name on the relay')
  console.log('')
  console.log('Env:')
  console.log('  VOIDLY_API                    default: https://api.voidly.ai')
  console.log('  HYDRA_HOME                    default: ~/.voidly-hydra')
  console.log('')
  console.log('Docs: https://voidly.ai/voidly-pay-hydra.md')
}

;(async () => {
  switch (cmd) {
    case 'init':    return cmdInit()
    case 'run':     return cmdRun()
    case 'status':  return cmdStatus()
    case 'publish': return cmdPublish()
    case 'delist':  return cmdDelist()
    case '-h': case '--help': case 'help': default: help()
  }
})().catch(e => { console.error(e); process.exit(1) })
