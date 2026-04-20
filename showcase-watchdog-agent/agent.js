#!/usr/bin/env node
/**
 * Voidly Pay Showcase Watchdog
 *
 * Continuous uptime guardian for the showcase fleet. Polls /v1/pay/health,
 * then hires each known provider's cheapest capability, verifies the
 * round-trip, and logs the result. On failure, optionally issues a
 * systemctl restart to bring the dead service back.
 *
 * Env:
 *   VOIDLY_API                  default: https://api.voidly.ai
 *   VOIDLY_WATCHDOG_DID         required — the watchdog's own DID
 *   VOIDLY_WATCHDOG_SECRET      required — base64 Ed25519 secret key
 *   VOIDLY_WATCHDOG_INTERVAL_MS default: 60_000
 *   VOIDLY_WATCHDOG_SERVICES    CSV of systemd services to restart on
 *                               failure. Example:
 *                               "voidly-showcase-echo,voidly-showcase-alt"
 *   VOIDLY_WATCHDOG_AUTO_RESTART default: "0" — set "1" to actually
 *                                exec systemctl restart.
 *   VOIDLY_WATCHDOG_STATE_FILE  default: /var/lib/voidly-watchdog/state.json
 *   VOIDLY_WATCHDOG_LOG_FILE    default: /var/log/voidly-watchdog.log
 *
 * The watchdog does NOT need admin credentials. It hires real providers
 * using its own faucet-funded wallet. After many runs it has a trust
 * history, which the /v1/pay/trust/{did} endpoint makes public — so the
 * watchdog's probing behavior is itself auditable.
 */

import { VoidlyPay, generateKeyPair, sha256Hex } from '@voidly/pay-sdk'
import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execSync } from 'node:child_process'

// ── Config ──────────────────────────────────────────────────────────────

const API             = process.env.VOIDLY_API || 'https://api.voidly.ai'
const DID             = process.env.VOIDLY_WATCHDOG_DID
const SECRET          = process.env.VOIDLY_WATCHDOG_SECRET
const INTERVAL_MS     = Number(process.env.VOIDLY_WATCHDOG_INTERVAL_MS || 60_000)
const SERVICES        = (process.env.VOIDLY_WATCHDOG_SERVICES || '').split(',').map(s => s.trim()).filter(Boolean)
const AUTO_RESTART    = process.env.VOIDLY_WATCHDOG_AUTO_RESTART === '1'
const STATE_FILE      = process.env.VOIDLY_WATCHDOG_STATE_FILE || '/var/lib/voidly-watchdog/state.json'
const LOG_FILE        = process.env.VOIDLY_WATCHDOG_LOG_FILE   || '/var/log/voidly-watchdog.log'
const MAX_FAILURES_BEFORE_RESTART = Number(process.env.VOIDLY_WATCHDOG_FAIL_THRESHOLD || 3)
const FAIL_COOLDOWN_MS = Number(process.env.VOIDLY_WATCHDOG_RESTART_COOLDOWN_MS || 10 * 60_000)

if (!DID || !SECRET) {
  console.error('fatal: VOIDLY_WATCHDOG_DID and VOIDLY_WATCHDOG_SECRET must be set')
  process.exit(1)
}

// ── Logging ─────────────────────────────────────────────────────────────

function log(level, msg, extra = null) {
  const rec = { ts: new Date().toISOString(), level, msg, ...(extra ?? {}) }
  const line = JSON.stringify(rec)
  console.log(line)
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

// ── State ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {}
  return { providers: {}, last_run: null, restarts: [] }
}

function saveState(st) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(st, null, 2))
  } catch (e) {
    log('warn', 'state write failed', { err: String(e) })
  }
}

// ── Pay SDK ─────────────────────────────────────────────────────────────

const pay = new VoidlyPay({ baseUrl: API, did: DID, signingSecretKey: SECRET })

// ── One probe cycle ─────────────────────────────────────────────────────

async function probe() {
  const cycle = { started_at: new Date().toISOString(), results: [] }

  // 1. Base health
  let healthOk = false
  try {
    const h = await fetch(`${API}/v1/pay/health`).then(r => r.json())
    healthOk = !h.system_frozen
    cycle.system_frozen = !!h.system_frozen
    if (!healthOk) log('warn', 'system_frozen=true — skipping provider probes this cycle')
  } catch (e) {
    log('error', 'health fetch failed', { err: String(e) })
    return cycle
  }
  if (!healthOk) return cycle

  // 2. Discover providers via capability search
  let providers = new Map()
  try {
    const r = await fetch(`${API}/v1/pay/capability/search?limit=200`).then(r => r.json())
    for (const c of (r.capabilities || [])) {
      if (!providers.has(c.did)) providers.set(c.did, [])
      providers.get(c.did).push(c)
    }
  } catch (e) {
    log('error', 'capability search failed', { err: String(e) })
    return cycle
  }

  // Don't probe ourselves.
  providers.delete(DID)

  // 3. Probe each provider
  for (const [did, caps] of providers.entries()) {
    const candidates = caps.filter(c => c.active).sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)
    const pick = candidates.find(c => c.capability === 'hash.sha256') ||
                 candidates.find(c => !c.capability.startsWith('llm.')) ||
                 candidates[0]
    if (!pick) {
      cycle.results.push({ did, status: 'no_capability' })
      continue
    }

    const started = Date.now()
    const input = pick.capability === 'hash.sha256'
      ? JSON.stringify({ text: `watchdog-${Date.now()}` })
      : JSON.stringify({ text: 'watchdog ping' })

    try {
      const hireRes = await pay.hire({
        capability_id: pick.id,
        input,
        delivery_deadline_hours: 1,
      })
      const hireId = hireRes?.hire?.id
      if (!hireId) throw new Error('no hire id')

      // Wait up to 45s for a receipt
      let receipt = null
      const deadline = Date.now() + 45_000
      while (Date.now() < deadline) {
        const h = await fetch(`${API}/v1/pay/hire/${hireId}`).then(r => r.json()).catch(() => null)
        const hire = h?.hire || h
        if (hire?.receipt_id) {
          const r = await fetch(`${API}/v1/pay/receipt/${hire.receipt_id}`).then(r => r.json()).catch(() => null)
          receipt = r?.receipt || r
          break
        }
        await new Promise(res => setTimeout(res, 2000))
      }

      const latency = Date.now() - started
      if (!receipt) {
        cycle.results.push({ did, capability: pick.capability, status: 'no_receipt', latency_ms: latency })
        continue
      }

      let verified = null
      if (pick.capability === 'hash.sha256') {
        try {
          const parsed = JSON.parse(input)
          const expected = await sha256Hex(parsed.text)
          verified = (receipt.work_hash || '').includes(expected) ||
                     (receipt.summary || '').includes(expected)
        } catch {}
      }

      cycle.results.push({
        did,
        capability: pick.capability,
        price_micro: pick.price_per_call_micro,
        status: 'ok',
        receipt_state: receipt.state,
        verified,
        latency_ms: latency,
      })
    } catch (e) {
      const latency = Date.now() - started
      cycle.results.push({ did, capability: pick.capability, status: 'hire_failed', error: String(e).slice(0, 240), latency_ms: latency })
    }
  }

  return cycle
}

// ── Restart logic ───────────────────────────────────────────────────────

function maybeRestart(did, consecutiveFailures, state) {
  if (!AUTO_RESTART || SERVICES.length === 0) return null
  if (consecutiveFailures < MAX_FAILURES_BEFORE_RESTART) return null

  // Cooldown: don't restart the same service more than once per window.
  const recentRestarts = (state.restarts || []).filter(r => Date.now() - new Date(r.ts).getTime() < FAIL_COOLDOWN_MS)
  const targets = SERVICES.map(svc => ({ svc, restarted_recently: recentRestarts.some(r => r.service === svc) }))

  // The watchdog doesn't know which DID maps to which service — it restarts
  // any service whose consecutive-failure threshold got tripped on a DID
  // and whose cooldown has elapsed. Conservative by default.
  const due = targets.filter(t => !t.restarted_recently)
  if (due.length === 0) return null

  for (const t of due) {
    try {
      execSync(`systemctl restart ${t.svc}`, { stdio: 'pipe' })
      log('warn', 'systemctl restart issued', { service: t.svc, reason_did: did, consecutiveFailures })
      state.restarts = [...recentRestarts, { ts: new Date().toISOString(), service: t.svc, reason_did: did }]
    } catch (e) {
      log('error', 'systemctl restart failed', { service: t.svc, err: String(e) })
    }
  }
  return due.map(t => t.svc)
}

// ── Main loop ───────────────────────────────────────────────────────────

async function main() {
  log('info', 'watchdog boot', { did: DID, interval_ms: INTERVAL_MS, auto_restart: AUTO_RESTART, services: SERVICES })

  const state = loadState()

  // Faucet on boot if balance missing/zero.
  try {
    const w = await fetch(`${API}/v1/pay/wallet/${DID}`).then(r => r.json()).catch(() => null)
    const bal = w?.wallet?.balance_micro ?? w?.balance_micro ?? 0
    if (bal < 1000) {
      log('info', 'faucet bootstrap')
      await pay.faucet()
    }
  } catch (e) {
    log('warn', 'wallet preflight failed', { err: String(e) })
  }

  let cycleCount = 0
  while (true) {
    cycleCount++
    const cycle = await probe()
    state.last_run = cycle.started_at

    for (const r of cycle.results) {
      const prev = state.providers[r.did] || { consecutive_failures: 0, total_runs: 0, total_ok: 0, total_failed: 0 }
      prev.total_runs += 1
      if (r.status === 'ok') {
        prev.consecutive_failures = 0
        prev.total_ok += 1
        prev.last_ok = cycle.started_at
        prev.last_latency_ms = r.latency_ms
      } else {
        prev.consecutive_failures += 1
        prev.total_failed += 1
        prev.last_error = r.error || r.status
        prev.last_fail = cycle.started_at
        log('warn', 'provider probe failed', { did: r.did, capability: r.capability, status: r.status, consecutive: prev.consecutive_failures })
        const restarted = maybeRestart(r.did, prev.consecutive_failures, state)
        if (restarted) prev.consecutive_failures = 0
      }
      state.providers[r.did] = prev
    }
    saveState(state)

    const okCount = cycle.results.filter(r => r.status === 'ok').length
    log('info', `cycle ${cycleCount}`, {
      providers_probed: cycle.results.length,
      ok: okCount,
      failed: cycle.results.length - okCount,
    })

    await new Promise(res => setTimeout(res, INTERVAL_MS))
  }
}

main().catch(e => {
  log('error', 'watchdog crash', { err: String(e) })
  process.exit(1)
})
