// @voidly/pay-vercel-ai
//
// Vercel AI SDK tool definitions that wrap the Voidly Pay marketplace.
// Returns a { voidly_capability_search, voidly_hire, voidly_wallet_balance }
// object ready to pass as the `tools` parameter of generateText / streamText.

import { tool } from 'ai'
import { z } from 'zod'
import { VoidlyPay, sha256Hex } from '@voidly/pay-sdk'

export interface VoidlyPayVercelConfig {
  did: string
  secretBase64: string
  baseUrl?: string
  maxPriceCredits?: number
  timeoutS?: number
  allowedCapabilities?: string[]
}

export function voidlyPayTools(cfg: VoidlyPayVercelConfig) {
  const pay = new VoidlyPay({
    did: cfg.did,
    secretBase64: cfg.secretBase64,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
  } as any)

  const maxPriceDefault = cfg.maxPriceCredits ?? 5
  const timeoutDefault = cfg.timeoutS ?? 90

  const voidly_capability_search = tool({
    description:
      'Search the Voidly Pay agent marketplace for priced capabilities. Returns cheapest-first list with each capability_id (required for voidly_hire), the provider DID, price_credits, and completion history. Call this BEFORE voidly_hire.',
    parameters: z.object({
      capability: z.string().optional().describe('Exact slug, e.g. hash.sha256 or llm.completion'),
      query: z.string().optional().describe('Free-text over name+description when the slug is unknown'),
      maxPriceCredits: z.number().optional().describe('Filter out expensive listings'),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute: async ({ capability, query, maxPriceCredits, limit }) => {
      const results = await (pay as any).capabilitySearch({
        capability, q: query, max_price_credits: maxPriceCredits, limit,
      })
      return (results || []).map((c: any) => ({
        capabilityId: c.id,
        capability: c.capability,
        name: c.name,
        providerDid: c.did,
        priceCredits: (c.price_per_call_micro ?? 0) / 1_000_000,
        slaHours: c.sla_deadline_hours,
        totalCompleted: c.total_completed,
        totalHires: c.total_hires,
        ratingAvg: c.rating_count > 0 ? c.rating_sum / c.rating_count : null,
      }))
    },
  })

  const voidly_hire = tool({
    description:
      'Hire a capability on Voidly Pay. Opens an escrow, waits for the provider\'s signed work claim, verifies sha256 locally where applicable, and returns the result. Requires capabilityId from voidly_capability_search + an input JSON payload.',
    parameters: z.object({
      capabilityId: z.string().describe('UUID from voidly_capability_search.capabilityId'),
      inputJson: z.string().describe('JSON string the capability expects, usually {"text":"..."}'),
      maxPriceCredits: z.number().optional(),
      timeoutS: z.number().int().optional(),
    }),
    execute: async ({ capabilityId, inputJson, maxPriceCredits, timeoutS }) => {
      const capLimit = maxPriceCredits ?? maxPriceDefault
      const timeout = (timeoutS ?? timeoutDefault) * 1000

      const cap = await (pay as any).capabilityGet?.(capabilityId)
        ?? await fetch(`${cfg.baseUrl || 'https://api.voidly.ai'}/v1/pay/capability/${capabilityId}`)
            .then(r => r.json()).then(d => d?.capability || d).catch(() => null)
      if (!cap?.id) return { error: 'capability not found', capabilityId }

      const priceCr = (cap.price_per_call_micro ?? 0) / 1_000_000
      if (priceCr > capLimit) return { error: 'price exceeds max', priceCredits: priceCr, maxPriceCredits: capLimit }
      if (cfg.allowedCapabilities && !cfg.allowedCapabilities.includes(cap.capability)) {
        return { error: 'capability not in allow-list', capability: cap.capability }
      }

      let parsedInput: any
      try { parsedInput = JSON.parse(inputJson) } catch { parsedInput = { text: inputJson } }

      let expectedHash: string | null = null
      if (cap.capability === 'hash.sha256' && typeof parsedInput?.text === 'string') {
        expectedHash = await sha256Hex(parsedInput.text)
      }

      const result = await (pay as any).hireAndWait({
        capabilityId,
        input: parsedInput,
        deliveryDeadlineHours: 1,
        pollIntervalMs: 2000,
        timeoutMs: timeout,
        verify: expectedHash ? (s: string) => s === expectedHash : undefined,
      })

      return {
        hireId: result?.hire?.id,
        receiptId: result?.receipt?.id,
        receiptState: result?.receipt?.state,
        summary: result?.receipt?.summary,
        accepted: !!result?.accepted,
        verifiedLocally: !!expectedHash && !!result?.accepted,
        priceCredits: priceCr,
      }
    },
  })

  const voidly_wallet_balance = tool({
    description: 'Return the hiring agent\'s Voidly Pay wallet balance and caps.',
    parameters: z.object({}),
    execute: async () => {
      const w = await (pay as any).walletGet?.()
        ?? await fetch(`${cfg.baseUrl || 'https://api.voidly.ai'}/v1/pay/wallet/${cfg.did}`)
            .then(r => r.json()).then(d => d?.wallet || d).catch(() => null)
      return {
        did: w?.did || cfg.did,
        balanceCredits: (w?.balance_micro ?? 0) / 1_000_000,
        dailyCapCredits: (w?.daily_cap_micro ?? 0) / 1_000_000,
        perTxCapCredits: (w?.per_tx_cap_micro ?? 0) / 1_000_000,
        frozen: !!w?.frozen,
      }
    },
  })

  return { voidly_capability_search, voidly_hire, voidly_wallet_balance }
}
