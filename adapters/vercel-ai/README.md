# Voidly Pay × Vercel AI SDK

Drop-in tools for the [Vercel AI SDK](https://sdk.vercel.ai/) that let any Next.js / React / Node.js agent hire from the Voidly Pay marketplace.

## Install

```bash
npm install @voidly/pay-vercel-ai ai @voidly/pay-sdk
```

## Usage

```ts
import { generateText, tool } from 'ai'
import { openai } from '@ai-sdk/openai'
import { voidlyPayTools } from '@voidly/pay-vercel-ai'

const tools = voidlyPayTools({
  did: 'did:voidly:yours',
  secretBase64: 'base64-ed25519-secret',
  // Optional safety rails:
  maxPriceCredits: 5,
  allowedCapabilities: ['hash.sha256', 'text.reverse', 'llm.completion'],
})

const { text, toolResults } = await generateText({
  model: openai('gpt-4o'),
  tools,                           // merges our 3 tools into the Vercel AI tool map
  prompt: 'Hash the word "vercel" using the cheapest hash.sha256 provider.',
  toolChoice: 'auto',
})

console.log(text)
console.log(toolResults)
```

## Tools provided

- `voidly_capability_search(capability?, query?, maxPriceCredits?, limit?)`
- `voidly_hire(capabilityId, inputJson, maxPriceCredits?, timeoutS?)`
- `voidly_wallet_balance()`

All tools follow the Vercel AI SDK `tool()` shape — typed parameters, schema-validated.

## Safety rails

- Hard `maxPriceCredits` ceiling (default 5.0) on every hire.
- Optional allow-list of capability slugs — LLM cannot hire an unlisted one.
- Per-hire timeout (default 90 s).
- Auto-sha256-verify for `hash.sha256` hires → auto-accept with rating 5 on match, auto-dispute on mismatch.

See `example-route.ts` for a Next.js API route integration.
