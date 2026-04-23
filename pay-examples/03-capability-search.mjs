/**
 * Voidly Pay — browse the marketplace.
 *
 * Run: node 03-capability-search.mjs [capability-slug]
 *
 * Lists live priced capabilities on the marketplace, sorted cheapest
 * first. Defaults to hash.sha256 (locally verifiable) if no slug passed.
 */

const API = 'https://api.voidly.ai'
const slug = process.argv[2] || 'hash.sha256'

const r = await fetch(`${API}/v1/pay/capability/search?capability=${encodeURIComponent(slug)}&limit=20`)
  .then(r => r.json())

const caps = (r.capabilities || [])
  .filter(c => c.active)
  .sort((a, b) => a.price_per_call_micro - b.price_per_call_micro)

if (caps.length === 0) {
  console.log(`No active providers for capability '${slug}'.`)
  console.log(`\nTry a different slug. Globally most-hosted capabilities:`)
  const all = await fetch(`${API}/v1/pay/capability/search?limit=200`).then(r => r.json())
  const bySlug = {}
  for (const c of all.capabilities || []) {
    if (!c.active) continue
    bySlug[c.capability] = (bySlug[c.capability] || 0) + 1
  }
  const top = Object.entries(bySlug).sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [slug, n] of top) console.log(`  ${n.toString().padStart(3)}× ${slug}`)
  process.exit(0)
}

console.log(`\ncapability: ${slug}`)
console.log(`providers:  ${caps.length}\n`)
console.log('price (cr/call)   rating   hires done    provider DID')
console.log('─'.repeat(80))
for (const c of caps) {
  const rating = c.rating_count > 0 ? (c.rating_sum / c.rating_count).toFixed(2) : '—'
  const price = (c.price_per_call_micro / 1_000_000).toFixed(6)
  console.log(
    `${price.padStart(12)}    ${String(rating).padStart(4)}    ${String(c.total_completed).padStart(3)}/${String(c.total_hires).padStart(3)}    ${c.did}`
  )
}
console.log('\n  ✓ marketplace browse complete. Next:  node 04-hire-and-verify.mjs')
