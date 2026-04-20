/**
 * Auto-pricing module for showcase-echo-agent.
 *
 * Repositions every listing relative to the current live market:
 *
 *   - If our listing is already the cheapest, hold steady unless we've
 *     been losing hires for too long (then we're probably too expensive
 *     for the work done — oddly that happens when people want premium
 *     reliability; we leave it alone).
 *   - If we're not cheapest AND we're losing volume (win_rate below
 *     threshold), undercut the cheapest competitor by 1 micro-credit,
 *     floored at `FLOOR_MICRO`.
 *   - If we're the only one providing a capability, drift our price
 *     toward `SOLO_TARGET_MICRO` very slowly (per run).
 *
 * Safe by default:
 *   - Never raises price above `CEILING_MICRO`.
 *   - Never drops below `FLOOR_MICRO`.
 *   - Never adjusts more than `MAX_DELTA_PCT` per run (10 %).
 *   - Requires `AUTO_PRICING_ENABLED=1` env before doing anything.
 *   - Prints the proposed change even when disabled — useful for review.
 *
 * Import + call from agent.js once per cycle, e.g.:
 *
 *   import { autoPrice } from './auto-pricing.js'
 *   await autoPrice({ api: API, did: DID, pay, log })
 */

const DEFAULTS = {
  FLOOR_MICRO:        100,        // 0.0001 cr
  CEILING_MICRO:      50_000,     // 0.05  cr
  SOLO_TARGET_MICRO:  1_000,      // 0.001 cr
  MAX_DELTA_PCT:      0.10,       // ±10 %
  MIN_HIRES_TO_DECIDE: 5,
  WIN_RATE_THRESHOLD: 0.3,        // if < 30 % of competitor-eligible hires
                                  // came to us, consider undercutting.
}

/**
 * @param {{
 *   api: string,
 *   did: string,
 *   pay: any,                          // VoidlyPay client from @voidly/pay-sdk
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   enabled?: boolean,
 *   config?: Partial<typeof DEFAULTS>
 * }} opts
 */
export async function autoPrice(opts) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) }
  const log = opts.log ?? ((lvl, msg, extra) => console.log(JSON.stringify({ ts: new Date().toISOString(), lvl, msg, ...(extra || {}) })))
  const enabled = opts.enabled ?? (process.env.AUTO_PRICING_ENABLED === '1')

  // Fetch our own listings + global listings.
  let ours = []
  let all = []
  try {
    const mine = await fetch(`${opts.api}/v1/pay/capability/did/${opts.did}`).then(r => r.json())
    ours = mine?.capabilities || []
    const global = await fetch(`${opts.api}/v1/pay/capability/search?limit=200`).then(r => r.json())
    all = global?.capabilities || []
  } catch (e) {
    log('warn', 'auto-pricing: fetch failed', { err: String(e) })
    return { changed: 0 }
  }

  let changed = 0
  for (const mine of ours) {
    if (!mine.active) continue

    // Find competitors for this capability slug (not us).
    const competitors = all.filter(c => c.capability === mine.capability && c.did !== opts.did && c.active)
    const cheapestCompetitor = competitors.length > 0
      ? competitors.sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)[0]
      : null

    let targetMicro = mine.price_per_call_micro

    if (!cheapestCompetitor) {
      // Solo provider — drift toward SOLO_TARGET_MICRO, one step at a time.
      const step = Math.round(Math.abs(cfg.SOLO_TARGET_MICRO - mine.price_per_call_micro) * 0.2)
      if (mine.price_per_call_micro > cfg.SOLO_TARGET_MICRO) {
        targetMicro = mine.price_per_call_micro - step
      } else if (mine.price_per_call_micro < cfg.SOLO_TARGET_MICRO) {
        targetMicro = mine.price_per_call_micro + step
      }
    } else {
      const totalCompetitorHires = competitors.reduce((s, c) => s + c.total_hires, 0)
      const ourHires = mine.total_hires
      const totalPool = totalCompetitorHires + ourHires
      const winRate = totalPool > 0 ? ourHires / totalPool : 0

      const weAreCheapest = mine.price_per_call_micro <= cheapestCompetitor.price_per_call_micro

      if (!weAreCheapest && totalPool >= cfg.MIN_HIRES_TO_DECIDE && winRate < cfg.WIN_RATE_THRESHOLD) {
        // Undercut cheapest competitor by 1 micro.
        targetMicro = Math.max(cfg.FLOOR_MICRO, cheapestCompetitor.price_per_call_micro - 1)
        log('info', `undercutting ${cheapestCompetitor.did.slice(0,30)}… on ${mine.capability}`, {
          our_price: mine.price_per_call_micro,
          their_price: cheapestCompetitor.price_per_call_micro,
          win_rate: winRate.toFixed(3),
          new_price: targetMicro,
        })
      } else if (weAreCheapest && winRate > 0.7 && mine.total_hires > cfg.MIN_HIRES_TO_DECIDE * 3) {
        // Cheapest AND dominant — test a 5% raise, bounded by ceiling.
        const proposed = Math.round(mine.price_per_call_micro * 1.05)
        targetMicro = Math.min(cfg.CEILING_MICRO, proposed)
      }
    }

    // Cap the delta per run.
    const maxDelta = Math.max(1, Math.round(mine.price_per_call_micro * cfg.MAX_DELTA_PCT))
    if (Math.abs(targetMicro - mine.price_per_call_micro) > maxDelta) {
      targetMicro = mine.price_per_call_micro + Math.sign(targetMicro - mine.price_per_call_micro) * maxDelta
    }

    // Clamp final.
    targetMicro = Math.max(cfg.FLOOR_MICRO, Math.min(cfg.CEILING_MICRO, targetMicro))

    if (targetMicro !== mine.price_per_call_micro) {
      log(enabled ? 'info' : 'dryrun', `reprice ${mine.capability}`, {
        from: mine.price_per_call_micro,
        to:   targetMicro,
        enabled,
      })
      if (enabled) {
        try {
          // Re-list with the same fields but a new price.
          await opts.pay.capabilityList({
            capability:            mine.capability,
            name:                  mine.name,
            description:           mine.description,
            price_credits:         targetMicro / 1_000_000,
            unit:                  mine.unit,
            sla_deadline_hours:    mine.sla_deadline_hours,
            tags:                  mine.tags_json ? JSON.parse(mine.tags_json) : [],
          })
          changed++
        } catch (e) {
          log('error', 'reprice failed', { capability: mine.capability, err: String(e) })
        }
      }
    }
  }

  return { changed, enabled }
}
