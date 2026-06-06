#!/usr/bin/env node
/**
 * x402 adapter for Voidly Pay.
 *
 * Exposes every capability in the marketplace as
 *   GET  /x402/<capability-slug>?<input-params>
 *
 * First hit returns HTTP 402 with headers describing what to sign.
 * Second hit carries x-payment-proof + x-payment-signature,
 * is forwarded to /v1/pay/hire, waits for a receipt, returns 200.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const API = process.env.VOIDLY_API || 'https://api.voidly.ai'
const PORT = Number(process.env.VOIDLY_X402_ADAPTER_PORT || 8412)

const PAYMENT_REQUEST_HEADERS = [
  'content-type',
  'authorization',
  'x-payment',
  'x-payment-proof',
  'x-payment-signature',
]

const PAYMENT_RESPONSE_HEADERS = [
  'payment-required',
  'x-payment-required',
  'x-payment-amount',
  'x-payment-capability-id',
  'x-payment-capability',
  'x-payment-provider-did',
  'x-payment-nonce',
  'x-payment-settled',
  'x-payment-receipt-state',
]

function writeCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS')
  res.setHeader('access-control-allow-headers', PAYMENT_REQUEST_HEADERS.join(', '))
  res.setHeader('access-control-expose-headers', PAYMENT_RESPONSE_HEADERS.join(', '))
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

async function findCheapest(slug) {
  const r = await fetch(`${API}/v1/pay/capability/search?capability=${encodeURIComponent(slug)}&limit=20`).then(r => r.json())
  const list = (r?.capabilities || []).filter(c => c.active).sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)
  return list[0] || null
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => resolve(data))
  })
}

async function postHirePrePaid({ envelope, signature }) {
  // Forward the client's already-signed envelope straight to the relay.
  const r = await fetch(`${API}/v1/pay/hire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  })
  if (!r.ok) throw new Error(`upstream /v1/pay/hire HTTP ${r.status}: ${await r.text()}`)
  return r.json()
}

async function waitForReceipt(hireId, deadlineMs = 60_000) {
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

const server = createServer(async (req, res) => {
  writeCors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`)

  if (url.pathname === '/pay/x402' || url.pathname === '/x402/discovery') {
    writeJson(res, 200, {
      name: 'Voidly Pay x402 adapter',
      docs: '/pay/x402',
      discovery: '/x402/discovery',
      resource_template: '/x402/{capability-slug}',
      request_headers: PAYMENT_REQUEST_HEADERS,
      response_headers: PAYMENT_RESPONSE_HEADERS,
      flow: 'Call /x402/{capability-slug}; a no-proof call returns 402 with payment-required headers; retry with x-payment-proof and x-payment-signature.',
    })
    return
  }

  if (!url.pathname.startsWith('/x402/')) {
    writeJson(res, 404, { error: 'expected /x402/<capability-slug> or /pay/x402' })
    return
  }

  const slug = url.pathname.slice('/x402/'.length)
  if (!slug) {
    writeJson(res, 400, { error: 'empty capability slug' })
    return
  }

  const cap = await findCheapest(slug).catch(() => null)
  if (!cap) {
    writeJson(res, 404, { error: `no active provider for capability '${slug}'` })
    return
  }

  const proof = req.headers['x-payment-proof']
  const sig   = req.headers['x-payment-signature']
  if (!proof || !sig) {
    // Issue the 402 challenge.
    const nonce = randomUUID()
    res.setHeader('payment-required', 'voidly-pay')
    res.setHeader('x-payment-required', 'voidly-pay')
    res.setHeader('x-payment-amount', String((cap.price_per_call_micro / 1_000_000).toFixed(6)))
    res.setHeader('x-payment-capability-id', cap.id)
    res.setHeader('x-payment-capability', cap.capability)
    res.setHeader('x-payment-provider-did', cap.did)
    res.setHeader('x-payment-nonce', nonce)
    res.setHeader('content-type', 'application/json')
    res.writeHead(402)
    res.end(JSON.stringify({
      scheme: 'voidly-pay',
      capability: cap.capability,
      capability_id: cap.id,
      provider_did: cap.did,
      price_micro: cap.price_per_call_micro,
      nonce,
      envelope_schema: 'voidly-pay-hire/v1',
      signature_algorithm: 'Ed25519',
      note: 'Build a voidly-pay-hire/v1 envelope, sign with your DID, resend with x-payment-proof (base64 envelope) + x-payment-signature.',
    }))
    return
  }

  // Client has paid — proxy the envelope.
  try {
    const envelope = JSON.parse(Buffer.from(String(proof), 'base64').toString('utf8'))
    const hireRes = await postHirePrePaid({ envelope, signature: String(sig) })
    const hireId = hireRes?.hire?.id || hireRes?.id
    if (!hireId) throw new Error('upstream did not return hire id')

    const receipt = await waitForReceipt(hireId)
    if (!receipt) {
      writeJson(res, 504, { error: 'timeout waiting for provider receipt', hire_id: hireId })
      return
    }

    res.setHeader('x-payment-settled', receipt.id)
    res.setHeader('x-payment-receipt-state', receipt.state)
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.end(JSON.stringify({
      capability: cap.capability,
      provider_did: cap.did,
      hire_id: hireId,
      receipt_id: receipt.id,
      work_hash: receipt.work_hash,
      output: (() => {
        try { return JSON.parse(receipt.summary || '{}') } catch { return receipt.summary || '' }
      })(),
    }))
  } catch (e) {
    writeJson(res, 502, { error: String(e.message || e), scheme: 'voidly-pay' })
  }
})

server.listen(PORT, () => {
  console.log(`voidly-pay x402 adapter listening on :${PORT}`)
  console.log(`GET http://localhost:${PORT}/x402/<capability-slug>`)
})
