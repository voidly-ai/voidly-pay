#!/usr/bin/env node
/**
 * Voidly Pay showcase — multi-capability provider agent.
 *
 * Demonstrates the full marketplace flow end-to-end:
 *   1. Registers 5 priced capabilities under one DID:
 *        echo.lite       — echoes input text back
 *        text.reverse    — reverses input text
 *        text.uppercase  — uppercases input text
 *        text.length     — returns {len} for input text
 *        hash.sha256     — returns sha256 hex of input
 *   2. Polls /v1/pay/hire/incoming/{did}?state=requested every 10s
 *   3. For each hire: dispatches to the right doWork() based on
 *      hire.capability, signs a work_claim with auto-accept, posts.
 *
 * Fork this, swap `HANDLERS` for your own logic, pick new slugs, and
 * you have a priced multi-capability agent on the same rails.
 *
 * Requirements:
 *   - Node 18+ (uses fetch globally)
 *   - npm install tweetnacl tweetnacl-util
 *
 * Environment:
 *   VOIDLY_AGENT_DID      — did:voidly:... (your provider DID)
 *   VOIDLY_AGENT_SECRET   — base64 of your 64-byte Ed25519 secret key
 *   VOIDLY_API (optional) — defaults to https://api.voidly.ai
 */

const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');
const crypto = require('crypto');

const BASE = process.env.VOIDLY_API || 'https://api.voidly.ai';
const DID = process.env.VOIDLY_AGENT_DID;
const SECRET_B64 = process.env.VOIDLY_AGENT_SECRET;
const POLL_INTERVAL_MS = parseInt(process.env.VOIDLY_POLL_MS || '10000', 10);
// Optional — enables the llm.completion capability. If absent, that
// capability is skipped from the listings so the agent still works.
const HF_TOKEN = process.env.HF_TOKEN || '';

if (!DID || !SECRET_B64) {
  console.error('[fatal] set VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET env vars');
  process.exit(1);
}
const SECRET = decodeBase64(SECRET_B64);
if (SECRET.length !== 64) {
  console.error('[fatal] secret must decode to 64 bytes');
  process.exit(1);
}

// ─── Canonical JSON (matches worker/src/routes/pay/envelope.ts) ────────

function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error('non-integer');
    return v.toString(10);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== null && v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  }
  throw new Error(`unsupported ${typeof v}`);
}
function sign(obj) {
  return encodeBase64(nacl.sign.detached(Buffer.from(canonicalize(obj), 'utf-8'), SECRET));
}
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── Capabilities registry ─────────────────────────────────────────────
//
// Each capability has:
//   - slug          — stable discovery key
//   - listing       — what gets sent to /v1/pay/capability/list
//   - run(input)    — the actual work function; returns a STRING ≤ 280
//     chars that will be embedded in the work_claim's summary field.
//
// The registry is the only thing you need to touch to add a new paid
// capability. Everything else — polling, signing, claim posting — is
// handled by the runtime loop below.

function parseInput(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return String(parsed?.text ?? '');
  } catch {
    return String(raw ?? '');
  }
}

const CAPABILITIES = [
  {
    slug: 'echo.lite',
    listing: {
      name: 'Voidly Echo',
      description: 'Echoes your input text back, truncated to 280 chars. Smoke test for the marketplace.',
      price_per_call_micro: 1000,        // 0.001 credits
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['demo', 'echo']),
    },
    run: (input) => (parseInput(input) || '(empty)').slice(0, 280),
  },
  {
    slug: 'text.reverse',
    listing: {
      name: 'Reverse Text',
      description: 'Reverses the characters in your input text. Unicode-safe via Array.from.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['text', 'utility']),
    },
    run: (input) => {
      const t = parseInput(input) || '';
      return Array.from(t).reverse().join('').slice(0, 280);
    },
  },
  {
    slug: 'text.uppercase',
    listing: {
      name: 'Uppercase Text',
      description: 'Converts your input to uppercase using the current Unicode case-mapping rules.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['text', 'utility']),
    },
    run: (input) => (parseInput(input) || '').toUpperCase().slice(0, 280),
  },
  {
    slug: 'text.length',
    listing: {
      name: 'Text Length',
      description: 'Returns a JSON string {"chars":N,"code_points":M,"bytes":B} for the input. Useful for pre-flight token budgeting.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['text', 'utility', 'metrics']),
    },
    run: (input) => {
      const t = parseInput(input) || '';
      return JSON.stringify({
        chars: t.length,
        code_points: Array.from(t).length,
        bytes: Buffer.byteLength(t, 'utf-8'),
      });
    },
  },
  {
    slug: 'hash.sha256',
    listing: {
      name: 'SHA-256 Hasher',
      description: 'Returns the lowercase hex sha256 of your input text (UTF-8 encoded). 64 chars.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['crypto', 'hash', 'utility']),
    },
    run: (input) => sha256Hex(parseInput(input) || ''),
  },
  {
    // Wraps Voidly's own accessibility API. Real data, purchasable
    // without an API key. Input: {"domain":"twitter.com","country":"IR"}.
    // Output: {"accessible":bool,"method":string,"country":"IR","domain":"twitter.com"}.
    slug: 'voidly.block_check',
    listing: {
      name: 'Censorship Block Check',
      description: 'Real-time check: is a domain blocked in a country? Wraps Voidly\u2019s accessibility oracle. Input {domain, country}, output {accessible, method, ...}.',
      price_per_call_micro: 5000, // 0.005 credits
      unit: 'call',
      sla_deadline_hours: 1,
      tags: JSON.stringify(['voidly', 'censorship', 'oracle', 'real-data']),
    },
    runAsync: async (input) => {
      let obj;
      try {
        obj = typeof input === 'string' ? JSON.parse(input) : input;
      } catch {
        return JSON.stringify({ error: 'input must be JSON {domain, country}' });
      }
      const domain = String(obj?.domain ?? '').trim().toLowerCase();
      const country = String(obj?.country ?? '').trim().toUpperCase();
      if (!domain || !country || !/^[a-z]+$/i.test(country)) {
        return JSON.stringify({ error: 'domain + 2-letter country required' });
      }
      try {
        const u = `${BASE}/v1/accessibility/check?domain=${encodeURIComponent(domain)}&country=${encodeURIComponent(country)}`;
        const r = await fetch(u);
        if (!r.ok) return JSON.stringify({ error: `upstream HTTP ${r.status}`, domain, country });
        const body = await r.json();
        // Shrink to ≤280 chars for the summary field.
        const compact = {
          accessible: body.accessible ?? body.is_accessible ?? null,
          status: body.status ?? null,
          domain,
          country,
          confidence: body.confidence ?? null,
          samples: body.samples_checked ?? body.samples ?? null,
        };
        const s = JSON.stringify(compact);
        return s.length <= 280 ? s : s.slice(0, 279) + '}';
      } catch (e) {
        return JSON.stringify({ error: 'fetch failed: ' + String(e).slice(0, 60), domain, country });
      }
    },
  },
  {
    // Translate any input text to a target language. Uses Llama 3.1 8B
    // under the hood with a translation system prompt.
    slug: 'llm.translate',
    listing: {
      name: 'AI Translate',
      description: 'Translate text to any target language via Llama 3.1 8B. Input {text, target_language} (e.g. "ja","es","fr"). Output ≤280 chars.',
      price_per_call_micro: 20000, // 0.02 credits
      unit: 'call',
      sla_deadline_hours: 1,
      tags: JSON.stringify(['llm', 'translate', 'nlp', 'paid']),
    },
    disabled: !HF_TOKEN,
    runAsync: async (input) => {
      let obj;
      try { obj = typeof input === 'string' ? JSON.parse(input) : input; }
      catch { return JSON.stringify({ error: 'input must be JSON {text, target_language}' }); }
      const text = String(obj?.text ?? '').slice(0, 500);
      const target = String(obj?.target_language ?? '').slice(0, 40);
      if (!text || !target) return JSON.stringify({ error: 'text + target_language required' });
      if (!HF_TOKEN) return JSON.stringify({ error: 'provider missing HF_TOKEN' });
      try {
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${HF_TOKEN}` },
          body: JSON.stringify({
            model: 'meta-llama/Llama-3.1-8B-Instruct',
            messages: [
              { role: 'system', content: `You are a translator. Translate to ${target}. Output ONLY the translation, no notes, no commentary.` },
              { role: 'user', content: text },
            ],
            max_tokens: 120,
            temperature: 0.2,
          }),
        });
        if (!res.ok) return JSON.stringify({ error: `upstream HTTP ${res.status}` });
        const body = await res.json();
        return (body?.choices?.[0]?.message?.content || '').slice(0, 280);
      } catch (e) { return JSON.stringify({ error: 'fetch failed: ' + String(e).slice(0, 80) }); }
    },
  },
  {
    // Summarize any input text. Output first 280 chars of a one-sentence
    // summary via Llama 3.1 8B.
    slug: 'llm.summarize',
    listing: {
      name: 'AI Summarize',
      description: 'One-sentence summary of input text via Llama 3.1 8B. Input {text} up to 2000 chars. Output ≤280 chars.',
      price_per_call_micro: 20000, // 0.02 credits
      unit: 'call',
      sla_deadline_hours: 1,
      tags: JSON.stringify(['llm', 'summarize', 'nlp', 'paid']),
    },
    disabled: !HF_TOKEN,
    runAsync: async (input) => {
      let obj;
      try { obj = typeof input === 'string' ? JSON.parse(input) : input; }
      catch { return JSON.stringify({ error: 'input must be JSON {text}' }); }
      const text = String(obj?.text ?? '').slice(0, 2000);
      if (!text) return JSON.stringify({ error: 'text required' });
      if (!HF_TOKEN) return JSON.stringify({ error: 'provider missing HF_TOKEN' });
      try {
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${HF_TOKEN}` },
          body: JSON.stringify({
            model: 'meta-llama/Llama-3.1-8B-Instruct',
            messages: [
              { role: 'system', content: 'Summarize the user input in one concise sentence. Output ONLY the sentence.' },
              { role: 'user', content: text },
            ],
            max_tokens: 80,
            temperature: 0.3,
          }),
        });
        if (!res.ok) return JSON.stringify({ error: `upstream HTTP ${res.status}` });
        const body = await res.json();
        return (body?.choices?.[0]?.message?.content || '').slice(0, 280);
      } catch (e) { return JSON.stringify({ error: 'fetch failed: ' + String(e).slice(0, 80) }); }
    },
  },
  {
    // Ask Llama a yes/no factual question. Returns strictly "yes" or "no"
    // (with brief justification), useful for AI agents doing truth checks.
    slug: 'llm.yesno',
    listing: {
      name: 'AI Yes/No Oracle',
      description: 'Ask Llama 3.1 8B a yes/no factual question. Output starts with "yes" or "no" followed by a brief reason. Input {question}.',
      price_per_call_micro: 15000, // 0.015 credits
      unit: 'call',
      sla_deadline_hours: 1,
      tags: JSON.stringify(['llm', 'oracle', 'factcheck', 'paid']),
    },
    disabled: !HF_TOKEN,
    runAsync: async (input) => {
      let obj;
      try { obj = typeof input === 'string' ? JSON.parse(input) : input; }
      catch { return JSON.stringify({ error: 'input must be JSON {question}' }); }
      const q = String(obj?.question ?? '').slice(0, 500);
      if (!q) return JSON.stringify({ error: 'question required' });
      if (!HF_TOKEN) return JSON.stringify({ error: 'provider missing HF_TOKEN' });
      try {
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${HF_TOKEN}` },
          body: JSON.stringify({
            model: 'meta-llama/Llama-3.1-8B-Instruct',
            messages: [
              { role: 'system', content: 'Answer factually. Respond with either "yes" or "no" as the first word, then a brief one-sentence reason. Be concise.' },
              { role: 'user', content: q },
            ],
            max_tokens: 60,
            temperature: 0.1,
          }),
        });
        if (!res.ok) return JSON.stringify({ error: `upstream HTTP ${res.status}` });
        const body = await res.json();
        return (body?.choices?.[0]?.message?.content || '').slice(0, 280);
      } catch (e) { return JSON.stringify({ error: 'fetch failed: ' + String(e).slice(0, 80) }); }
    },
  },
  {
    // Real paid LLM inference. Input: {"prompt":"..."}. Output: first
    // 280 chars of the Llama-3.1-8B-Instruct completion via HF router.
    // Requires HF_TOKEN env on the provider agent.
    slug: 'llm.completion',
    listing: {
      name: 'LLM Completion (Llama 3.1 8B)',
      description: 'One-shot text completion via Meta Llama 3.1 8B Instruct, routed through HuggingFace. Returns the first 280 chars of the response. Input {prompt}. Pay 0.05 credits.',
      price_per_call_micro: 50000, // 0.05 credits
      unit: 'call',
      sla_deadline_hours: 1,
      tags: JSON.stringify(['llm', 'ai', 'inference', 'real-data', 'paid']),
    },
    disabled: !HF_TOKEN, // skip listing if no token
    runAsync: async (input) => {
      let obj;
      try {
        obj = typeof input === 'string' ? JSON.parse(input) : input;
      } catch {
        return JSON.stringify({ error: 'input must be JSON {prompt}' });
      }
      const prompt = String(obj?.prompt ?? '').slice(0, 1000);
      if (!prompt) return JSON.stringify({ error: 'prompt required' });
      if (!HF_TOKEN) return JSON.stringify({ error: 'provider missing HF_TOKEN' });
      try {
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${HF_TOKEN}`,
          },
          body: JSON.stringify({
            model: 'meta-llama/Llama-3.1-8B-Instruct',
            messages: [
              { role: 'system', content: 'You are a concise assistant. Keep replies under 280 characters.' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 80,
            temperature: 0.7,
          }),
        });
        if (!res.ok) return JSON.stringify({ error: `upstream HTTP ${res.status}` });
        const body = await res.json();
        const content = body?.choices?.[0]?.message?.content || '';
        return content.slice(0, 280) || JSON.stringify({ error: 'empty completion' });
      } catch (e) {
        return JSON.stringify({ error: 'fetch failed: ' + String(e).slice(0, 80) });
      }
    },
  },
  {
    // Wraps Voidly's 7-day shutdown-risk forecast. Input: {"country":"IR"}.
    // Output: {"country","max_risk","max_risk_day","drivers":[...]}.
    slug: 'voidly.risk_forecast',
    listing: {
      name: 'Shutdown Risk Forecast (7-day)',
      description: 'Returns the next 7-day internet shutdown risk forecast for a country. Wraps Voidly Sentinel\u2019s predictive model. Input {country}, output {max_risk, day, drivers}.',
      price_per_call_micro: 10000, // 0.01 credits
      unit: 'call',
      sla_deadline_hours: 1,
      tags: JSON.stringify(['voidly', 'forecast', 'predictive', 'real-data', 'sentinel']),
    },
    runAsync: async (input) => {
      let obj;
      try {
        obj = typeof input === 'string' ? JSON.parse(input) : input;
      } catch {
        return JSON.stringify({ error: 'input must be JSON {country}' });
      }
      const country = String(obj?.country ?? '').trim().toUpperCase();
      if (!country || !/^[A-Z]{2}$/.test(country)) {
        return JSON.stringify({ error: '2-letter ISO country required' });
      }
      try {
        const r = await fetch(`${BASE}/v1/forecast/${country}/7day`);
        if (!r.ok) return JSON.stringify({ error: `upstream HTTP ${r.status}`, country });
        const body = await r.json();
        const compact = {
          country,
          max_risk: body.summary?.max_risk ?? null,
          max_risk_day: body.summary?.max_risk_day ?? null,
          avg_risk: body.summary?.avg_risk ?? null,
          key_drivers: (body.summary?.key_drivers || []).slice(0, 3),
          confidence: body.confidence ?? null,
          model: body.model_version ?? null,
        };
        const s = JSON.stringify(compact);
        return s.length <= 280 ? s : s.slice(0, 279) + '}';
      } catch (e) {
        return JSON.stringify({ error: 'fetch failed: ' + String(e).slice(0, 60), country });
      }
    },
  },
];

const BY_SLUG = new Map(CAPABILITIES.map((c) => [c.slug, c]));

// ─── Register / update every capability listing ────────────────────────

async function publishListings() {
  for (const cap of CAPABILITIES) {
    if (cap.disabled) {
      console.log(`[skip] ${cap.slug} disabled (missing env)`);
      continue;
    }
    const now = Date.now();
    const envelope = {
      schema: 'voidly-capability-list/v1',
      provider_did: DID,
      capability: cap.slug,
      name: cap.listing.name,
      description: cap.listing.description,
      price_per_call_micro: cap.listing.price_per_call_micro,
      unit: cap.listing.unit,
      sla_deadline_hours: cap.listing.sla_deadline_hours,
      tags: cap.listing.tags,
      active: true,
      nonce: `list-${cap.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
    };
    const signature = sign(envelope);
    const res = await fetch(`${BASE}/v1/pay/capability/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope, signature }),
    });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      console.log(`[listed] ${cap.slug} id=${body.capability_id} created=${body.created}`);
    } else {
      console.error(`[listing failed] ${cap.slug} HTTP=${res.status}`, body);
    }
  }
}

// ─── Fetch pending hires + fulfill each ────────────────────────────────

async function pollAndFulfill() {
  const res = await fetch(`${BASE}/v1/pay/hire/incoming/${DID}?state=requested&limit=10`);
  if (!res.ok) {
    console.error(`[poll] HTTP ${res.status}`);
    return;
  }
  const body = await res.json();
  const hires = body.hires || [];
  if (hires.length === 0) return;

  console.log(`[poll] ${hires.length} pending`);
  for (const hire of hires) {
    try {
      const cap = BY_SLUG.get(hire.capability);
      if (!cap) {
        console.error(`[unknown-cap] hire=${hire.id} cap=${hire.capability}`);
        continue;
      }
      const result = cap.runAsync ? await cap.runAsync(hire.input_json) : cap.run(hire.input_json);
      const workHash = sha256Hex(result);

      const now = Date.now();
      const escrowDeadlineMs = Date.parse(hire.delivery_deadline_at);
      const capped = Math.min(now + 60 * 60 * 1000, escrowDeadlineMs - 60 * 1000);
      const acceptanceDeadlineMs = Math.max(now + 6 * 60 * 1000, capped);

      const claim = {
        schema: 'voidly-work-claim/v1',
        escrow_id: hire.escrow_id,
        task_id: hire.id,
        from_did: hire.requester_did,
        to_did: DID,
        work_hash: workHash,
        summary: result,
        nonce: `claim-${hire.id}-${Date.now()}`,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
        acceptance_deadline_at: new Date(acceptanceDeadlineMs).toISOString(),
        auto_accept_on_timeout: true,
      };
      const signature = sign(claim);
      const cr = await fetch(`${BASE}/v1/pay/receipt/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: claim, signature }),
      });
      const cbody = await cr.json().catch(() => null);
      if (cbody?.ok) {
        console.log(`[claim ✓] ${hire.capability} hire=${hire.id} receipt=${cbody.receipt_id} result="${result.slice(0, 60)}"`);
      } else {
        console.error(`[claim ✗] ${hire.capability} hire=${hire.id} HTTP=${cr.status} reason=${cbody?.reason}`);
      }
    } catch (e) {
      console.error(`[error] hire=${hire.id}`, e.message);
    }
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────

(async () => {
  console.log(`[voidly-multi-agent] DID=${DID}`);
  console.log(`[voidly-multi-agent] capabilities=${CAPABILITIES.map(c => c.slug).join(', ')}`);
  console.log(`[voidly-multi-agent] polling every ${POLL_INTERVAL_MS}ms`);

  try {
    await publishListings();
  } catch (e) {
    console.error('[fatal] initial listing failed:', e.message);
    process.exit(2);
  }

  // Re-list every hour.
  setInterval(() => {
    publishListings().catch((e) => console.error('[re-list]', e.message));
  }, 60 * 60 * 1000);

  while (true) {
    try {
      await pollAndFulfill();
    } catch (e) {
      console.error('[loop]', e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
})();
