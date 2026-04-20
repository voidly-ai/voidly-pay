#!/usr/bin/env node
/**
 * OpenAI-compatible chat completions adapter for Voidly Pay.
 *
 * Listens on POST /v1/chat/completions with the OpenAI request shape,
 * dispatches to the cheapest live llm.completion provider in the
 * Voidly Pay marketplace, and returns a payload that looks like the
 * OpenAI response.
 *
 * Run:
 *   VOIDLY_OPENAI_ADAPTER_DID=did:voidly:... \
 *   VOIDLY_OPENAI_ADAPTER_SECRET=base64... \
 *   VOIDLY_OPENAI_ADAPTER_PORT=8411 \
 *   node server.js
 */

import { createServer } from 'node:http'
import { VoidlyPay } from '@voidly/pay-sdk'

const API = process.env.VOIDLY_API || 'https://api.voidly.ai'
const DID = process.env.VOIDLY_OPENAI_ADAPTER_DID
const SECRET = process.env.VOIDLY_OPENAI_ADAPTER_SECRET
const PORT = Number(process.env.VOIDLY_OPENAI_ADAPTER_PORT || 8411)

if (!DID || !SECRET) {
  console.error('fatal: VOIDLY_OPENAI_ADAPTER_DID and VOIDLY_OPENAI_ADAPTER_SECRET must be set')
  process.exit(1)
}

const pay = new VoidlyPay({ baseUrl: API, did: DID, signingSecretKey: SECRET })

let CAP_CACHE = { cap: null, expires: 0 }

async function pickCompletionCap() {
  if (CAP_CACHE.cap && Date.now() < CAP_CACHE.expires) return CAP_CACHE.cap
  const res = await fetch(`${API}/v1/pay/capability/search?capability=llm.completion&limit=10`).then(r => r.json())
  const caps = (res?.capabilities || []).filter(c => c.active).sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)
  if (caps.length === 0) throw new Error('no llm.completion providers available in marketplace')
  CAP_CACHE = { cap: caps[0], expires: Date.now() + 5 * 60_000 }
  return caps[0]
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function messagesToPrompt(messages) {
  // Naive: flatten to a system + user style prompt.
  // Enough for most OpenAI callers we've seen.
  const parts = []
  for (const m of (messages || [])) {
    const role = m.role || 'user'
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : '')
    parts.push(`${role === 'system' ? 'System' : role === 'assistant' ? 'Assistant' : 'User'}: ${content}`)
  }
  parts.push('Assistant:')
  return parts.join('\n')
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
  throw new Error('timeout waiting for receipt')
}

async function handleChatCompletions(req, res) {
  const req_id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
  try {
    const body = await readJsonBody(req)
    if (body?.stream) {
      res.writeHead(501, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'streaming not supported by voidly-pay adapter', type: 'invalid_request_error' } }))
      return
    }

    const cap = await pickCompletionCap()
    const prompt = messagesToPrompt(body.messages)
    const input = JSON.stringify({
      prompt,
      max_tokens: body.max_tokens ?? 512,
      temperature: body.temperature ?? 0.7,
    })

    const hireRes = await pay.hire({
      capability_id: cap.id,
      input,
      delivery_deadline_hours: 1,
    })
    const hireId = hireRes?.hire?.id
    if (!hireId) throw new Error('hire did not return id')

    const receipt = await waitForReceipt(hireId)
    let completion = ''
    try {
      const parsed = JSON.parse(receipt.summary || '{}')
      completion = parsed.completion || parsed.text || parsed.response || receipt.summary || ''
    } catch {
      completion = receipt.summary || ''
    }

    // Accept the receipt so escrow releases to the provider. If we
    // wanted retries on bad output, we'd skip accept here and let
    // auto-accept expire.
    if (receipt.state === 'claimed') {
      try { await pay.workAccept({ receipt_id: receipt.id, rating: 5 }) } catch {}
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: req_id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || cap.capability,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: completion },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      voidly_pay: {
        capability_id: cap.id,
        provider_did: cap.did,
        price_micro: cap.price_per_call_micro,
        hire_id: hireId,
        receipt_id: receipt.id,
      },
    }))
  } catch (e) {
    console.error('chat.completions error:', e)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: String(e.message || e), type: 'voidly_pay_upstream' } }))
  }
}

async function handleModels(_req, res) {
  try {
    const r = await fetch(`${API}/v1/pay/capability/search?capability=llm.completion&limit=20`).then(r => r.json())
    const caps = r?.capabilities || []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: caps.map(c => ({
        id: `voidly/${c.capability}:${c.did.slice(0, 20)}`,
        object: 'model',
        created: Math.floor(Date.parse(c.listed_at || Date.now()) / 1000),
        owned_by: c.did,
        voidly_pay: {
          capability_id: c.id,
          price_micro: c.price_per_call_micro,
          rating: c.rating_count > 0 ? (c.rating_sum / c.rating_count) : null,
        },
      })),
    }))
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: String(e) } }))
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  const url = req.url?.split('?')[0] || ''
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    return handleChatCompletions(req, res)
  }
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    return handleModels(req, res)
  }
  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, adapter: 'voidly-pay-openai-compat', did: DID }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'not found', supported: ['POST /v1/chat/completions', 'GET /v1/models', 'GET /healthz'] } }))
})

server.listen(PORT, () => {
  console.log(`voidly-pay openai-compat adapter listening on :${PORT}`)
  console.log(`POST http://localhost:${PORT}/v1/chat/completions`)
  console.log(`adapter DID: ${DID}`)
})
