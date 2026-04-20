#!/usr/bin/env node
/**
 * A2A adapter for Voidly Pay.
 *
 * Serves /.well-known/agent-card.json with one skill per live Voidly
 * Pay capability, and accepts A2A tasks/send requests which it
 * translates into Voidly Pay hires.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { VoidlyPay } from '@voidly/pay-sdk'

const API        = process.env.VOIDLY_API || 'https://api.voidly.ai'
const DID        = process.env.VOIDLY_A2A_ADAPTER_DID
const SECRET     = process.env.VOIDLY_A2A_ADAPTER_SECRET
const PORT       = Number(process.env.VOIDLY_A2A_ADAPTER_PORT || 8413)
const PUBLIC_URL = process.env.VOIDLY_A2A_PUBLIC_URL || `http://localhost:${PORT}`

if (!DID || !SECRET) {
  console.error('fatal: VOIDLY_A2A_ADAPTER_DID and VOIDLY_A2A_ADAPTER_SECRET must be set')
  process.exit(1)
}

const pay = new VoidlyPay({ baseUrl: API, did: DID, signingSecretKey: SECRET })

let CAPS_CACHE = { list: [], expires: 0 }
async function getCaps() {
  if (Date.now() < CAPS_CACHE.expires) return CAPS_CACHE.list
  const r = await fetch(`${API}/v1/pay/capability/search?limit=200`).then(r => r.json())
  CAPS_CACHE = { list: r?.capabilities || [], expires: Date.now() + 60_000 }
  return CAPS_CACHE.list
}

function capabilityToSkill(c) {
  const tags = []
  try { if (c.tags_json) tags.push(...JSON.parse(c.tags_json)) } catch {}
  return {
    id: c.capability,
    name: c.name,
    description: (c.description || '').slice(0, 240),
    tags: Array.from(new Set([c.capability.split('.')[0], ...tags])),
    examples: [`call ${c.capability}`],
    voidly_pay: {
      capability_id: c.id,
      provider_did:  c.did,
      price_micro:   c.price_per_call_micro,
      unit:          c.unit,
      sla_deadline_hours: c.sla_deadline_hours,
    },
  }
}

async function handleAgentCard(_req, res) {
  const caps = await getCaps()
  // Dedupe by capability slug — pick cheapest per slug.
  const bySlug = new Map()
  for (const c of caps.sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)) {
    if (!bySlug.has(c.capability) && c.active) bySlug.set(c.capability, c)
  }
  const skills = [...bySlug.values()].map(capabilityToSkill)

  const card = {
    name: 'Voidly Pay Marketplace',
    description: 'Every active capability in the Voidly Pay marketplace, exposed as A2A skills. Pay-per-call via the adapter\u2019s own wallet.',
    url: PUBLIC_URL,
    protocolVersion: '0.3.0',
    provider: { organization: 'Voidly Research', url: 'https://voidly.ai' },
    documentationUrl: 'https://voidly.ai/pay',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills,
    voidly_pay: {
      adapter_did: DID,
      pay_manifest_url: `${API}/v1/pay/manifest.json`,
      federation_url: 'https://voidly.ai/pay/federation',
      stats_url: `${API}/v1/pay/stats`,
    },
  }
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, max-age=60')
  res.writeHead(200); res.end(JSON.stringify(card, null, 2))
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

async function waitForReceipt(hireId, deadlineMs = 90_000) {
  const stop = Date.now() + deadlineMs
  while (Date.now() < stop) {
    const h = await fetch(`${API}/v1/pay/hire/${hireId}`).then(r => r.json()).catch(() => null)
    const hire = h?.hire || h
    if (hire?.receipt_id) {
      const r = await fetch(`${API}/v1/pay/receipt/${hire.receipt_id}`).then(r => r.json()).catch(() => null)
      return r?.receipt || r
    }
    await new Promise(res => setTimeout(res, 2000))
  }
  return null
}

async function handleTasksSend(req, res) {
  try {
    const body = await readJsonBody(req)
    // Support both the bare A2A shape and JSON-RPC 2.0 { method, params }
    const params = body.params || body
    const skillId = params.skillId || params.skill_id || params.id
    const input   = params.input  ?? params.parameters ?? params.message?.parts?.[0]?.text
    if (!skillId) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing skillId' }))
      return
    }

    const caps = await getCaps()
    const pick = caps
      .filter(c => c.active && c.capability === skillId)
      .sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)[0]
    if (!pick) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `unknown skill '${skillId}'` }))
      return
    }

    const taskId = body.id || randomUUID()
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input || {})

    const hireRes = await pay.hire({
      capability_id: pick.id,
      input: inputStr,
      task_id: taskId,
      delivery_deadline_hours: 1,
    })
    const hireId = hireRes?.hire?.id
    const receipt = await waitForReceipt(hireId)
    let output = null
    try { output = JSON.parse(receipt?.summary || '{}') } catch { output = receipt?.summary || '' }

    if (receipt?.state === 'claimed') {
      try { await pay.workAccept({ receipt_id: receipt.id, rating: 5 }) } catch {}
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        taskId,
        status: receipt ? 'completed' : 'timeout',
        output,
        voidly_pay: {
          capability_id: pick.id,
          provider_did:  pick.did,
          hire_id:       hireId,
          receipt_id:    receipt?.id,
        },
      },
    }))
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e.message || e) }))
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = (req.url || '/').split('?')[0]
  if (req.method === 'GET' && url === '/.well-known/agent-card.json') return handleAgentCard(req, res)
  if (req.method === 'POST' && (url === '/tasks/send' || url === '/v1/tasks/send' || url === '/')) return handleTasksSend(req, res)
  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, adapter: 'voidly-pay-a2a', did: DID }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', supported: ['GET /.well-known/agent-card.json', 'POST /tasks/send', 'GET /healthz'] }))
})

server.listen(PORT, () => {
  console.log(`voidly-pay a2a adapter listening on :${PORT}`)
  console.log(`agent card: ${PUBLIC_URL}/.well-known/agent-card.json`)
  console.log(`tasks/send: ${PUBLIC_URL}/tasks/send`)
})
