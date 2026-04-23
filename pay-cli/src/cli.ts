/**
 * @voidly/pay-cli — command-line tool for Voidly Pay.
 *
 * Usage:
 *   voidly-pay init                    Generate + store a fresh DID
 *   voidly-pay whoami                  Show DID + balance
 *   voidly-pay faucet                  Claim the one-shot starter grant
 *   voidly-pay stats                   Platform-wide marketplace stats
 *   voidly-pay search [slug] [--max N] List priced capabilities
 *   voidly-pay hire <id> --input '<j>' Hire a provider + auto-accept
 *   voidly-pay balance [did]           Read a wallet
 *   voidly-pay trust [did]             Read provider/requester stats
 *   voidly-pay doctor                  Diagnose common install issues
 *
 * Config: ~/.voidly-pay/config.json OR env (VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET)
 */

import { VoidlyPay, generateKeyPair, sha256Hex, MICRO_PER_CREDIT } from '@voidly/pay-sdk'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.voidly-pay')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

interface Config {
  did: string
  publicKeyBase64: string
  secretKeyBase64: string
}

function loadConfig(): Config | null {
  // Env vars take precedence.
  if (process.env.VOIDLY_AGENT_DID && process.env.VOIDLY_AGENT_SECRET) {
    return {
      did: process.env.VOIDLY_AGENT_DID,
      publicKeyBase64: '',
      secretKeyBase64: process.env.VOIDLY_AGENT_SECRET,
    }
  }
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config
    } catch {
      return null
    }
  }
  return null
}

function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

function client(cfg: Config): VoidlyPay {
  return new VoidlyPay({ did: cfg.did, secretBase64: cfg.secretKeyBase64 })
}

function requireCfg(): Config {
  const cfg = loadConfig()
  if (!cfg) {
    console.error('No identity configured. Run `voidly-pay init` first, or set VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET env vars.')
    process.exit(2)
  }
  return cfg
}

function fmtCr(micro: number): string {
  return `${(micro / MICRO_PER_CREDIT).toFixed(4)} cr`
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === `--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`)
}

// ─── Commands ─────────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<void> {
  if (loadConfig() && !hasFlag(args, 'force')) {
    const existing = loadConfig()!
    console.log(`Identity already exists: ${existing.did}`)
    console.log('Pass --force to replace. (Your current identity is wiped and old credits become unreachable.)')
    return
  }
  const kp = generateKeyPair()
  saveConfig(kp)
  console.log(`✓ Generated new identity`)
  console.log(`  DID:    ${kp.did}`)
  console.log(`  Stored: ${CONFIG_PATH} (chmod 600)`)
  console.log(``)
  console.log(`Next steps:`)
  console.log(`  1. Register with the relay so the faucet can verify your signature:`)
  console.log(`     curl -sX POST https://api.voidly.ai/v1/agent/register \\`)
  console.log(`       -H 'content-type: application/json' \\`)
  console.log(`       -d '{"name":"my-agent","signing_public_key":"${kp.publicKeyBase64}","encryption_public_key":"${kp.publicKeyBase64}"}'`)
  console.log(`  2. voidly-pay faucet`)
}

async function cmdWhoami(): Promise<void> {
  const cfg = requireCfg()
  const pay = client(cfg)
  let balance = 'unknown'
  try {
    const w = await pay.wallet()
    balance = fmtCr(w.balance_credits) + ` (locked ${fmtCr(w.locked_credits)})`
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('404')) balance = 'no wallet (run `voidly-pay faucet` to create)'
    else balance = 'error: ' + msg.slice(0, 80)
  }
  console.log(`DID:     ${cfg.did}`)
  console.log(`Balance: ${balance}`)
}

async function cmdFaucet(): Promise<void> {
  const cfg = requireCfg()
  const pay = client(cfg)
  await pay.ensureWallet()
  const r = await pay.faucet()
  if (r.ok) {
    console.log(`✓ Faucet claimed ${fmtCr(r.amount_micro!)}`)
    console.log(`  New balance: ${fmtCr(r.new_balance_micro!)}`)
  } else {
    console.error(`✗ Faucet failed: ${r.reason}`)
    if (r.reason === 'agent_pubkey_not_found') {
      console.error('  → Register your pubkey with the relay first:')
      console.error(`     POST https://api.voidly.ai/v1/agent/register with signing_public_key`)
    }
    process.exit(1)
  }
}

async function cmdStats(): Promise<void> {
  const pay = new VoidlyPay()
  const s = await pay.stats()
  console.log(`Voidly Pay marketplace — ${s.generated_at}`)
  console.log(``)
  console.log(`  wallets:       ${s.wallets.total} (${s.wallets.active_24h} active 24h)`)
  console.log(`  capabilities:  ${s.capabilities.active} active · ${s.capabilities.distinct_providers} providers`)
  console.log(`  hires:         ${s.hires.total} · ${s.hires.total_completed} completed · ${s.hires.last_24h} in 24h`)
  console.log(`  value settled: ${fmtCr(s.value_settled.total_micro)} total · ${fmtCr(s.value_settled.last_24h_micro)} in 24h`)
  console.log(``)
  console.log(`Top capabilities by hires:`)
  for (const c of s.top_capabilities.slice(0, 10)) {
    const rating = c.rating_avg !== null ? `★${c.rating_avg}` : '—'
    console.log(`  ${c.capability.padEnd(22)} ${fmtCr(c.price_per_call_micro).padEnd(10)}  ${c.total_completed}/${c.total_hires} done  ${rating}  ${c.did.slice(0, 20)}…`)
  }
}

async function cmdSearch(args: string[]): Promise<void> {
  const pay = new VoidlyPay()
  const slug = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const max = parseFlag(args, 'max')
  const caps = await pay.capabilitySearch({
    capability: slug,
    maxPriceCredits: max ? parseFloat(max) : undefined,
    limit: 30,
  })
  if (caps.length === 0) {
    console.log('No matching capabilities.')
    return
  }
  console.log(`${caps.length} capability ${caps.length === 1 ? 'listing' : 'listings'}:`)
  for (const c of caps) {
    const rating = c.rating_count > 0 ? `★${(c.rating_sum / c.rating_count).toFixed(1)}` : 'new'
    console.log(``)
    console.log(`  ${c.capability}  —  ${c.name}`)
    console.log(`    id:       ${c.id}`)
    console.log(`    provider: ${c.did}`)
    console.log(`    price:    ${fmtCr(c.price_per_call_micro)} per ${c.unit}`)
    console.log(`    sla:      ${c.sla_deadline_hours}h`)
    console.log(`    stats:    ${c.total_completed}/${c.total_hires} completed · ${c.total_disputed} disputed · ${rating}`)
  }
}

async function cmdHire(args: string[]): Promise<void> {
  const cfg = requireCfg()
  const pay = client(cfg)
  const id = args[0]
  if (!id) {
    console.error('Usage: voidly-pay hire <capability_id> --input \'<json>\'')
    process.exit(2)
  }
  const inputStr = parseFlag(args, 'input') || '{"text":"hello from voidly-pay-cli"}'
  let input: unknown
  try {
    input = JSON.parse(inputStr)
  } catch {
    input = { text: inputStr }
  }

  console.log(`→ hiring ${id}`)
  console.log(`  input: ${JSON.stringify(input).slice(0, 120)}`)

  const start = Date.now()
  const r = await pay.hireAndWait({
    capabilityId: id,
    input: input as string | object,
    timeoutMs: 120_000,
    pollIntervalMs: 2000,
  })
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  console.log(``)
  console.log(`✓ ${r.hire.state} in ${elapsed}s`)
  console.log(`  hire_id:   ${r.hire.id}`)
  console.log(`  escrow_id: ${r.hire.escrow_id}`)
  console.log(`  receipt:   ${r.receipt.id}`)
  console.log(``)
  console.log(`Result:`)
  console.log(`  ${r.receipt.summary}`)
  console.log(``)
  console.log(`Accepted: ${r.accepted}  ·  escrow released: ${r.escrow_released}`)
}

async function cmdBalance(args: string[]): Promise<void> {
  const did = args[0] || requireCfg().did
  const pay = new VoidlyPay({ did })
  try {
    const w = await pay.wallet(did)
    console.log(`DID:      ${did}`)
    console.log(`Balance:  ${fmtCr(w.balance_credits)}`)
    console.log(`Locked:   ${fmtCr(w.locked_credits)}`)
    console.log(`Frozen:   ${w.frozen ? 'YES' : 'no'}`)
    console.log(`Caps:     daily ${fmtCr(w.daily_cap_credits)} · per-tx ${fmtCr(w.per_tx_cap_credits)}`)
  } catch (e) {
    console.error(`Error reading wallet: ${(e as Error).message}`)
    process.exit(1)
  }
}

/**
 * `voidly-pay doctor` — diagnose the common things a new install can get wrong.
 *
 * Runs a sequence of checks and prints a compact status line per check.
 * Exits 0 when everything green, 1 when any check is red.
 */
async function cmdDoctor(_args: string[]): Promise<void> {
  const checks: Array<{ name: string; pass: boolean | null; detail: string }> = []

  const record = (name: string, pass: boolean | null, detail: string) => {
    checks.push({ name, pass, detail })
  }

  // 1. Can we reach the API?
  try {
    const r = await fetch('https://api.voidly.ai/v1/pay/health', { signal: AbortSignal.timeout(5000) })
    const h = await r.json().catch(() => ({} as { system_frozen?: boolean; counts?: { wallets?: number } }))
    if (r.status !== 200) {
      record('API reachable', false, `HTTP ${r.status}`)
    } else if (h.system_frozen) {
      record('API reachable', false, 'system frozen — transfers paused')
    } else {
      record('API reachable', true, `healthy, ${h.counts?.wallets ?? '?'} wallets on ledger`)
    }
  } catch (e: unknown) {
    record('API reachable', false, `network error: ${(e as Error)?.message ?? e}`)
  }

  // 2. Config file / env present?
  const cfg = loadConfig()
  if (!cfg) {
    record('DID configured', false, `no ${CONFIG_PATH}, no env vars — run 'voidly-pay init'`)
  } else {
    const source = process.env.VOIDLY_AGENT_DID ? 'env' : 'config file'
    record('DID configured', true, `${cfg.did.slice(0, 40)}… (from ${source})`)
  }

  // 3. Secret key format — quick sanity check.
  if (cfg) {
    const secretOk = typeof cfg.secretKeyBase64 === 'string' && cfg.secretKeyBase64.length >= 80
    record('Secret key format', secretOk, secretOk ? `base64 length ${cfg.secretKeyBase64.length}` : 'missing or too short')
  }

  // 4. Relay register state (does the worker know this pubkey?)
  if (cfg) {
    try {
      const r = await fetch(`https://api.voidly.ai/v1/agent/identity/${encodeURIComponent(cfg.did)}`, { signal: AbortSignal.timeout(5000) })
      if (r.status === 200) {
        record('Pubkey registered', true, 'relay knows this DID')
      } else if (r.status === 404) {
        record('Pubkey registered', false, "relay does not know this DID — pay writes will return 'sender_pubkey_not_found'. Re-run 'voidly-pay init' or POST /v1/agent/register.")
      } else {
        record('Pubkey registered', null, `unexpected HTTP ${r.status}`)
      }
    } catch (e: unknown) {
      record('Pubkey registered', null, `check failed: ${(e as Error)?.message ?? e}`)
    }
  }

  // 5. Wallet + balance
  if (cfg) {
    try {
      const r = await fetch(`https://api.voidly.ai/v1/pay/wallet/${encodeURIComponent(cfg.did)}`, { signal: AbortSignal.timeout(5000) })
      if (r.status === 200) {
        const w = await r.json() as { wallet?: { balance_micro?: number; frozen?: boolean }; balance_micro?: number; frozen?: boolean }
        const balance = w.wallet?.balance_micro ?? w.balance_micro ?? 0
        const frozen = w.wallet?.frozen ?? w.frozen ?? false
        if (frozen) {
          record('Wallet state', false, 'WALLET FROZEN — admin action required')
        } else if (balance === 0) {
          record('Wallet state', false, "balance 0 cr — run 'voidly-pay faucet' to claim starter credits")
        } else {
          record('Wallet state', true, `${fmtCr(balance)}`)
        }
      } else if (r.status === 404) {
        record('Wallet state', false, "no wallet yet — run 'voidly-pay faucet' to create + fund it")
      } else {
        record('Wallet state', null, `unexpected HTTP ${r.status}`)
      }
    } catch (e: unknown) {
      record('Wallet state', null, `check failed: ${(e as Error)?.message ?? e}`)
    }
  }

  // 6. Clock sync — envelopes are rejected if the client clock skews past the window.
  try {
    const t0 = Date.now()
    const r = await fetch('https://api.voidly.ai/v1/pay/health', { signal: AbortSignal.timeout(5000) })
    const serverDate = r.headers.get('date')
    if (serverDate) {
      const skewMs = Math.abs(Date.parse(serverDate) - t0)
      if (skewMs < 60_000) {
        record('Clock skew', true, `${Math.round(skewMs)}ms vs api.voidly.ai`)
      } else if (skewMs < 600_000) {
        record('Clock skew', null, `${Math.round(skewMs / 1000)}s — close to the 60-minute envelope window, consider sync`)
      } else {
        record('Clock skew', false, `${Math.round(skewMs / 1000)}s off — envelopes will be rejected. Sync your system clock.`)
      }
    } else {
      record('Clock skew', null, 'server did not return a Date header')
    }
  } catch (e: unknown) {
    record('Clock skew', null, `check failed: ${(e as Error)?.message ?? e}`)
  }

  // Render
  console.log('')
  console.log('voidly-pay doctor')
  console.log('─'.repeat(60))
  let failed = 0
  for (const c of checks) {
    const icon = c.pass === true ? '✓' : c.pass === false ? '✗' : '·'
    const color = c.pass === true ? '\x1b[32m' : c.pass === false ? '\x1b[31m' : '\x1b[33m'
    console.log(`${color}${icon}\x1b[0m ${c.name.padEnd(22)} ${c.detail}`)
    if (c.pass === false) failed++
  }
  console.log('─'.repeat(60))
  if (failed === 0) {
    console.log('\x1b[32mAll clear.\x1b[0m You can hire or publish right now.')
    process.exit(0)
  } else {
    console.log(`\x1b[31m${failed} check${failed === 1 ? '' : 's'} failing.\x1b[0m Follow the hint next to each red line.`)
    process.exit(1)
  }
}

async function cmdTrust(args: string[]): Promise<void> {
  const did = args[0] || requireCfg().did
  const pay = new VoidlyPay()
  const t = await pay.trust(did)
  console.log(`DID: ${did}`)
  console.log(``)
  console.log(`As provider:`)
  console.log(`  total hires:      ${t.as_provider.total_hires}`)
  console.log(`  completed:        ${t.as_provider.total_completed}`)
  console.log(`  disputed:         ${t.as_provider.total_disputed}`)
  console.log(`  completion rate:  ${(t.as_provider.completion_rate * 100).toFixed(1)}%`)
  console.log(`  rating:           ${t.as_provider.rating_avg !== null ? t.as_provider.rating_avg + '/5 (' + t.as_provider.rating_count + ')' : '— (no ratings)'}`)
  console.log(`  earned:           ${fmtCr(t.as_provider.total_earned_micro)}`)
  console.log(`  active caps:      ${t.as_provider.active_capabilities} of ${t.as_provider.total_capabilities}`)
  console.log(``)
  console.log(`As requester:`)
  console.log(`  posted:           ${t.as_requester.total_hires_posted}`)
  console.log(`  accepted:         ${t.as_requester.total_accepted}`)
  console.log(`  disputed:         ${t.as_requester.total_disputed}`)
  console.log(`  spent:            ${fmtCr(t.as_requester.total_spent_micro)}`)
}

function printUsage(): void {
  console.log(`voidly-pay — command-line tool for the Voidly Pay marketplace`)
  console.log(``)
  console.log(`Usage:`)
  console.log(`  voidly-pay init                    Generate + store a fresh DID`)
  console.log(`  voidly-pay whoami                  Show DID + balance`)
  console.log(`  voidly-pay faucet                  Claim the 10-credit starter grant`)
  console.log(`  voidly-pay stats                   Platform-wide marketplace stats`)
  console.log(`  voidly-pay search [slug] [--max N] List priced capabilities`)
  console.log(`  voidly-pay hire <id> --input '<j>' Hire a provider + auto-accept`)
  console.log(`  voidly-pay balance [did]           Read a wallet`)
  console.log(`  voidly-pay trust [did]             Read provider+requester stats`)
  console.log(`  voidly-pay doctor                  Diagnose common install issues`)
  console.log(``)
  console.log(`Config: ~/.voidly-pay/config.json OR env (VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET)`)
  console.log(`Docs:   https://voidly.ai/pay  ·  https://voidly.ai/pay/try`)
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  try {
    switch (cmd) {
      case 'init':    await cmdInit(rest); break
      case 'whoami':  await cmdWhoami(); break
      case 'faucet':  await cmdFaucet(); break
      case 'stats':   await cmdStats(); break
      case 'search':  await cmdSearch(rest); break
      case 'hire':    await cmdHire(rest); break
      case 'balance': await cmdBalance(rest); break
      case 'trust':   await cmdTrust(rest); break
      case 'doctor':  await cmdDoctor(rest); break
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printUsage(); break
      default:
        console.error(`Unknown command: ${cmd}`)
        printUsage()
        process.exit(2)
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

main()
