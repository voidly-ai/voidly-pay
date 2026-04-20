#!/usr/bin/env node
/**
 * Voidly Pay — autonomous probe/requester agent.
 *
 * The other side of the marketplace: an agent that HIRES. On boot it
 * claims the faucet (one-shot 10 credits). Then every N minutes it
 * picks a `hash.sha256` provider from the marketplace, hires them,
 * waits for the work, verifies locally, and either accepts (rating 5)
 * or disputes (rating via dispute_reason).
 *
 * This is simultaneously:
 *   - Proof that the full autonomous flow works (no humans touch it)
 *   - A continuous quality check on providers
 *   - A realistic requester agent anyone can fork to automate their
 *     own pay-to-use agent workflows (swap the test + capability)
 *
 * Environment:
 *   VOIDLY_AGENT_DID      — did:voidly:… probe agent DID
 *   VOIDLY_AGENT_SECRET   — base64 Ed25519 64-byte secret
 *   VOIDLY_API            — defaults to https://api.voidly.ai
 *   VOIDLY_PROBE_INTERVAL_MS — between hires (default 300_000 = 5min)
 *   VOIDLY_PROBE_CAPABILITY  — slug to test (default "hash.sha256")
 *   VOIDLY_PROBE_MIN_COMPLETION_RATE — skip providers below this (default 0.5)
 */

const nacl = require('tweetnacl');
const { decodeBase64, encodeBase64 } = require('tweetnacl-util');
const crypto = require('crypto');

const BASE = process.env.VOIDLY_API || 'https://api.voidly.ai';
const DID = process.env.VOIDLY_AGENT_DID;
const SECRET_B64 = process.env.VOIDLY_AGENT_SECRET;
const INTERVAL_MS = parseInt(process.env.VOIDLY_PROBE_INTERVAL_MS || '300000', 10);
const PROBE_SLUG = process.env.VOIDLY_PROBE_CAPABILITY || 'hash.sha256';
const MIN_COMPLETION_RATE = parseFloat(process.env.VOIDLY_PROBE_MIN_COMPLETION_RATE || '0.5');

if (!DID || !SECRET_B64) {
  console.error('[fatal] set VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET');
  process.exit(1);
}
const SECRET = decodeBase64(SECRET_B64);
if (SECRET.length !== 64) {
  console.error('[fatal] secret must decode to 64 bytes');
  process.exit(1);
}

// ─── Canonical JSON + sign ─────────────────────────────────────────────

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Faucet (one-shot on first boot) ───────────────────────────────────

async function ensureFaucet() {
  const wr = await fetch(`${BASE}/v1/pay/wallet/${DID}`);
  if (wr.ok) {
    const w = (await wr.json()).wallet;
    if (w && w.balance_credits > 0) {
      console.log(`[wallet] balance already ${w.balance_credits} micro, skipping faucet`);
      return;
    }
  } else if (wr.status === 404) {
    // wallet doesn't exist yet — POST /v1/pay/wallet to create
    await fetch(`${BASE}/v1/pay/wallet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: DID }),
    });
  }

  const now = Date.now();
  const env = {
    schema: 'voidly-pay-faucet/v1',
    did: DID,
    nonce: `probe-faucet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
  };
  const res = await fetch(`${BASE}/v1/pay/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: env, signature: sign(env) }),
  });
  const body = await res.json().catch(() => null);
  if (body?.ok) {
    console.log(`[faucet] claimed ${body.amount_micro} micro, new balance ${body.new_balance_micro}`);
  } else if (body?.reason === 'already_claimed') {
    console.log('[faucet] already claimed (expected on restarts)');
  } else {
    console.error(`[faucet] failed HTTP=${res.status} reason=${body?.reason}`);
  }
}

// ─── Pick a provider + hire ────────────────────────────────────────────

async function pickProvider() {
  const res = await fetch(`${BASE}/v1/pay/capability/search?capability=${PROBE_SLUG}&limit=20`);
  if (!res.ok) return null;
  const body = await res.json();
  const caps = (body.capabilities || []).filter((c) => c.did !== DID);
  if (caps.length === 0) return null;

  // For each, fetch trust and filter.
  const scored = [];
  for (const cap of caps) {
    try {
      const tr = await fetch(`${BASE}/v1/pay/trust/${cap.did}`);
      if (!tr.ok) continue;
      const trust = await tr.json();
      const rate = trust.as_provider.completion_rate ?? 1;
      if (rate < MIN_COMPLETION_RATE) continue;
      scored.push({ cap, trust, rate });
    } catch {}
  }
  if (scored.length === 0) return null;
  // Pick the cheapest that passes the bar.
  scored.sort((a, b) => a.cap.price_per_call_micro - b.cap.price_per_call_micro);
  return scored[0];
}

function generateTestInput() {
  const samples = [
    'The quick brown fox jumps over the lazy dog',
    'Hello, Voidly Pay!',
    'This is an autonomous probe — ' + new Date().toISOString(),
    crypto.randomBytes(16).toString('hex'),
    'abc',
    '',
  ];
  return samples[Math.floor(Math.random() * samples.length)];
}

async function probeOne() {
  const pick = await pickProvider();
  if (!pick) {
    console.log(`[skip] no ${PROBE_SLUG} providers meet completion_rate ≥ ${MIN_COMPLETION_RATE}`);
    return;
  }
  const { cap, trust } = pick;
  const text = generateTestInput();
  const expectedHash = sha256Hex(text);
  console.log(`[probe] provider=${cap.did} price=${cap.price_per_call_micro}µ rate=${(trust.as_provider.completion_rate * 100).toFixed(1)}% text="${text.slice(0, 40)}" expected=${expectedHash.slice(0, 16)}…`);

  // Hire.
  const now = Date.now();
  const hire = {
    schema: 'voidly-hire-request/v1',
    capability_id: cap.id,
    capability: cap.capability,
    requester_did: DID,
    provider_did: cap.did,
    price_micro: cap.price_per_call_micro,
    task_id: `probe-${Date.now()}`,
    input_json: JSON.stringify({ text }),
    delivery_deadline_hours: 1,
    nonce: `h-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  const hireRes = await fetch(`${BASE}/v1/pay/hire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: hire, signature: sign(hire) }),
  });
  const hireBody = await hireRes.json().catch(() => null);
  if (!hireBody?.ok) {
    console.error(`[hire-fail] provider=${cap.did} reason=${hireBody?.reason}`);
    return;
  }
  const { hire_id, receipt_id: _r, escrow_id } = hireBody;
  console.log(`[hired] hire=${hire_id} escrow=${escrow_id}`);

  // Wait for claim.
  let receipt_id = null;
  const start = Date.now();
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const hr = await fetch(`${BASE}/v1/pay/hire/${hire_id}`);
    if (!hr.ok) continue;
    const h = (await hr.json()).hire;
    if (h.state === 'claimed') { receipt_id = h.receipt_id; break; }
    if (h.state === 'expired' || h.state === 'completed' || h.state === 'disputed') break;
  }
  if (!receipt_id) {
    console.error(`[timeout] hire=${hire_id} did not claim in 60s`);
    return;
  }
  const waitSec = ((Date.now() - start) / 1000).toFixed(1);

  // Verify.
  const rr = await fetch(`${BASE}/v1/pay/receipt/${receipt_id}`);
  const receipt = (await rr.json()).receipt;
  const returned = receipt.summary;
  const correct = returned === expectedHash;

  const actNow = Date.now();
  const accEnv = {
    schema: 'voidly-work-acceptance/v1',
    receipt_id,
    signer_did: DID,
    action: correct ? 'accept' : 'dispute',
    action_nonce: `a-${Date.now()}`,
    issued_at: new Date(actNow).toISOString(),
    expires_at: new Date(actNow + 10 * 60 * 1000).toISOString(),
  };
  if (correct) {
    accEnv.rating = 5;
    accEnv.feedback = 'autonomous probe verified correct';
  } else {
    accEnv.dispute_reason = `hash mismatch: expected ${expectedHash.slice(0, 16)}… got ${String(returned).slice(0, 16)}…`;
  }
  const ar = await fetch(`${BASE}/v1/pay/receipt/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: accEnv, signature: sign(accEnv) }),
  });
  const ab = await ar.json().catch(() => null);

  if (correct) {
    console.log(`[✓ accept] provider=${cap.did} claimed in ${waitSec}s, rated 5/5, escrow_released=${ab?.escrow_released}`);
  } else {
    console.log(`[✗ dispute] provider=${cap.did} wrong hash, disputed. expected=${expectedHash.slice(0, 16)} got=${String(returned).slice(0, 16)}`);
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────

(async () => {
  console.log(`[probe] DID=${DID} capability=${PROBE_SLUG} interval=${INTERVAL_MS}ms min_rate=${MIN_COMPLETION_RATE}`);
  try {
    await ensureFaucet();
  } catch (e) {
    console.error('[faucet-error]', e.message);
  }

  while (true) {
    try {
      await probeOne();
    } catch (e) {
      console.error('[loop-error]', e.message);
    }
    await sleep(INTERVAL_MS);
  }
})();
