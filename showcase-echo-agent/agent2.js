#!/usr/bin/env node
/**
 * Voidly Pay — SECOND showcase provider.
 *
 * Competes with the primary provider on `hash.sha256` (cheaper) and
 * `text.reverse` (same price). Adds two unique capabilities to keep
 * the marketplace varied:
 *   - `text.word_count`   — split on whitespace, count.
 *   - `json.minify`       — validate + minify JSON input.
 *
 * This exists so agents surveying the marketplace see multiple
 * providers compete + so the probe naturally picks this one for
 * hash.sha256 (cheapest-first ranking).
 *
 * Same runtime as agent.js — only the capability registry differs.
 */

const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');
const crypto = require('crypto');

const BASE = process.env.VOIDLY_API || 'https://api.voidly.ai';
const DID = process.env.VOIDLY_AGENT_DID;
const SECRET_B64 = process.env.VOIDLY_AGENT_SECRET;
const POLL_INTERVAL_MS = parseInt(process.env.VOIDLY_POLL_MS || '10000', 10);

if (!DID || !SECRET_B64) {
  console.error('[fatal] set VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET');
  process.exit(1);
}
const SECRET = decodeBase64(SECRET_B64);
if (SECRET.length !== 64) {
  console.error('[fatal] secret must decode to 64 bytes');
  process.exit(1);
}

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
const sign = (o) => encodeBase64(nacl.sign.detached(Buffer.from(canonicalize(o), 'utf-8'), SECRET));
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseInput(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed;
  } catch {
    return null;
  }
}
function parseText(raw) {
  const p = parseInput(raw);
  return String(p?.text ?? raw ?? '');
}

const CAPABILITIES = [
  {
    slug: 'hash.sha256',
    listing: {
      name: 'SHA-256 Hasher (budget)',
      description: 'Same as hash.sha256 from the main showcase, 20% cheaper. Competitive pressure demo.',
      price_per_call_micro: 800, // UNDERCUT — 0.0008 credits
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['crypto', 'hash', 'utility', 'budget']),
    },
    run: (input) => sha256Hex(parseText(input)),
  },
  {
    slug: 'text.reverse',
    listing: {
      name: 'Reverse Text (alt)',
      description: 'Unicode-safe character reversal. Same price as the main provider — pick whichever has the better rating.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['text', 'utility', 'alt']),
    },
    run: (input) => Array.from(parseText(input)).reverse().join('').slice(0, 280),
  },
  {
    slug: 'text.word_count',
    listing: {
      name: 'Word Counter',
      description: 'Splits text on Unicode whitespace and returns {words: N, unique: M} as JSON. Useful for pre-flight token budgeting.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['text', 'utility', 'metrics']),
    },
    run: (input) => {
      const t = parseText(input);
      const words = t.trim().split(/\s+/).filter(Boolean);
      const unique = new Set(words).size;
      return JSON.stringify({ words: words.length, unique });
    },
  },
  {
    slug: 'json.minify',
    listing: {
      name: 'JSON Minifier',
      description: 'Parses your input as JSON and returns minified form (no whitespace). Returns {"error":"..."} on malformed input. Input field: raw JSON string or {"json":...}.',
      price_per_call_micro: 1000,
      unit: 'call',
      sla_deadline_hours: 24,
      tags: JSON.stringify(['json', 'utility', 'format']),
    },
    run: (input) => {
      // Accept either raw JSON string in `input` or {"json": <anything>}
      let target;
      try {
        const parsed = typeof input === 'string' ? JSON.parse(input) : input;
        target = parsed && typeof parsed === 'object' && 'json' in parsed ? parsed.json : parsed;
      } catch {
        try {
          target = JSON.parse(String(input ?? ''));
        } catch {
          return JSON.stringify({ error: 'input is not valid JSON' });
        }
      }
      try {
        const s = JSON.stringify(target);
        return s.length <= 280 ? s : JSON.stringify({ error: 'minified output exceeds 280 chars (summary limit); pass smaller payloads' });
      } catch {
        return JSON.stringify({ error: 'JSON.stringify failed' });
      }
    },
  },
];

const BY_SLUG = new Map(CAPABILITIES.map((c) => [c.slug, c]));

async function publishListings() {
  for (const cap of CAPABILITIES) {
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
    if (body?.ok) console.log(`[listed] ${cap.slug} id=${body.capability_id} created=${body.created}`);
    else console.error(`[listing failed] ${cap.slug} HTTP=${res.status}`, body);
  }
}

async function pollAndFulfill() {
  const res = await fetch(`${BASE}/v1/pay/hire/incoming/${DID}?state=requested&limit=10`);
  if (!res.ok) { console.error(`[poll] HTTP ${res.status}`); return; }
  const body = await res.json();
  const hires = body.hires || [];
  if (hires.length === 0) return;
  console.log(`[poll] ${hires.length} pending`);
  for (const hire of hires) {
    try {
      const cap = BY_SLUG.get(hire.capability);
      if (!cap) { console.error(`[unknown] hire=${hire.id} cap=${hire.capability}`); continue; }
      const result = cap.run(hire.input_json);
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
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: claim, signature }),
      });
      const cbody = await cr.json().catch(() => null);
      if (cbody?.ok) console.log(`[claim ✓] ${hire.capability} hire=${hire.id}`);
      else console.error(`[claim ✗] ${hire.capability} HTTP=${cr.status} reason=${cbody?.reason}`);
    } catch (e) {
      console.error(`[error] hire=${hire.id}`, e.message);
    }
  }
}

(async () => {
  console.log(`[voidly-alt-agent] DID=${DID} capabilities=${CAPABILITIES.map(c => c.slug).join(', ')}`);
  try { await publishListings(); } catch (e) { console.error('[fatal]', e.message); process.exit(2); }
  setInterval(() => publishListings().catch(e => console.error('[re-list]', e.message)), 60 * 60 * 1000);
  while (true) {
    try { await pollAndFulfill(); } catch (e) { console.error('[loop]', e.message); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
})();
