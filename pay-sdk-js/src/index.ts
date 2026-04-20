/**
 * @voidly/pay-sdk — TypeScript SDK for Voidly Pay.
 *
 * One ergonomic class that handles:
 *   - Canonical JSON + Ed25519 signing (matches worker/src/routes/pay/envelope.ts)
 *   - All 34 HTTPS endpoints under api.voidly.ai/v1/pay/*
 *   - Typed response shapes
 *   - Convenience helpers (hireAndWait, sha256Hex, buildWorkClaim)
 *
 * Works in Node 18+ (global fetch + WebCrypto) and modern browsers.
 */

import nacl from "tweetnacl";
// tweetnacl-util is a CJS package — named ESM imports fail at runtime in
// strict ESM (Node via `.mjs` or package.json `"type": "module"`). Use
// the default import and destructure. This works in CJS + ESM equally.
import tweetnaclUtil from "tweetnacl-util";
const { decodeBase64, encodeBase64 } = tweetnaclUtil;

// ─── Types ────────────────────────────────────────────────────────────────

export const MICRO_PER_CREDIT = 1_000_000;

export interface VoidlyPayConfig {
  /** did:voidly:... identifier. Required for any signed operation. */
  did?: string;
  /** Base64 of your 64-byte Ed25519 secret key. Required for signing. */
  secretBase64?: string;
  /** Defaults to https://api.voidly.ai */
  apiBase?: string;
  /** Optional fetch override for testing / proxying. */
  fetchImpl?: typeof fetch;
}

export type EnvelopeValue = string | number | boolean | null | undefined | EnvelopeValue[] | { [k: string]: EnvelopeValue };

export interface WalletState {
  did: string;
  balance_credits: number;
  locked_credits: number;
  daily_cap_credits: number;
  per_tx_cap_credits: number;
  frozen: number;
  owner_did: string | null;
  created_at: string;
  updated_at?: string;
}

export interface TransferReceipt {
  schema: "voidly-pay-receipt/v1";
  status: "settled" | "failed";
  transfer_id: string;
  envelope_hash: string;
  settled_at?: string;
  sender_new_balance_micro?: number;
  recipient_new_balance_micro?: number;
  reason?: string;
}

export interface EscrowOpenResult {
  ok: boolean;
  schema?: string;
  escrow_id?: string;
  envelope_hash?: string;
  opened_at?: string;
  state?: string;
  from_did?: string;
  to_did?: string;
  amount_micro?: number;
  deadline_at?: string;
  sender_new_balance_micro?: number;
  sender_locked_credits?: number;
  reason?: string;
}

export interface CapabilityListing {
  id: string;
  did: string;
  capability: string;
  name: string;
  description: string;
  price_per_call_micro: number;
  unit: string;
  sla_deadline_hours: number;
  active: number;
  total_hires: number;
  total_completed: number;
  total_disputed: number;
  rating_sum: number;
  rating_count: number;
  listed_at: string;
  updated_at: string;
}

export interface HireResult {
  ok: boolean;
  hire_id?: string;
  escrow_id?: string;
  capability_id?: string;
  provider_did?: string;
  price_micro?: number;
  delivery_deadline_at?: string;
  created_at?: string;
  reason?: string;
}

export interface HireRow {
  id: string;
  capability_id: string;
  capability: string;
  requester_did: string;
  provider_did: string;
  escrow_id: string;
  price_micro: number;
  task_id: string;
  input_json: string | null;
  delivery_deadline_at: string;
  state: "requested" | "claimed" | "completed" | "disputed" | "expired";
  receipt_id: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface WorkReceipt {
  id: string;
  escrow_id: string | null;
  task_id: string;
  from_did: string;
  to_did: string;
  work_hash: string;
  summary: string | null;
  state: "pending_acceptance" | "accepted" | "disputed" | "expired";
  acceptance_deadline_at: string;
  auto_accept_on_timeout: number;
  claimed_at: string;
  accepted_at: string | null;
  disputed_at: string | null;
  escrow_released: number;
  rating: number | null;
  feedback: string | null;
}

export interface TrustSnapshot {
  schema: "voidly-pay-trust/v1";
  did: string;
  as_provider: {
    total_hires: number;
    total_completed: number;
    total_disputed: number;
    total_in_flight: number;
    total_expired: number;
    completion_rate: number;
    rating_avg: number | null;
    rating_count: number;
    total_earned_micro: number;
    active_capabilities: number;
    total_capabilities: number;
  };
  as_requester: {
    total_hires_posted: number;
    total_accepted: number;
    total_disputed: number;
    total_expired: number;
    total_in_flight: number;
    total_spent_micro: number;
  };
  wallet: { exists: boolean; balance_micro: number; locked_micro: number; frozen: boolean };
  notes: string[];
  generated_at: string;
}

export interface PayStats {
  schema: "voidly-pay-stats/v1";
  generated_at: string;
  wallets: { total: number; active_24h: number };
  capabilities: { total: number; active: number; distinct_providers: number };
  hires: { total: number; total_completed: number; total_disputed: number; last_24h: number; last_1h: number };
  value_settled: { total_micro: number; last_24h_micro: number };
  top_capabilities: Array<CapabilityListing & { rating_avg: number | null }>;
  top_providers_by_earnings: Array<{ did: string; total_earned_micro: number; total_completed: number; active_capabilities: number }>;
  recent_hires: Array<{ id: string; capability: string; price_micro: number; state: string; created_at: string; completed_at: string | null }>;
}

// ─── Canonical JSON (must match worker envelope.ts bit-for-bit) ──────────

export function canonicalize(v: EnvelopeValue): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error("canonicalize: only finite integers supported");
    }
    return v.toString(10);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== null && v[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k] as EnvelopeValue)).join(",") + "}";
  }
  throw new Error(`canonicalize: unsupported ${typeof v}`);
}

export function canonicalBytes(v: EnvelopeValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(v));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  // Cast via ArrayBuffer slice — TS 5 tightened the BufferSource type so
  // Uint8Array<SharedArrayBuffer> vs ArrayBuffer discrimination matters.
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uuidish(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function bool(b: boolean): 1 | 0 {
  return b ? 1 : 0;
}

// ─── Main class ──────────────────────────────────────────────────────────

export class VoidlyPay {
  readonly did?: string;
  readonly apiBase: string;
  private readonly secret?: Uint8Array;
  private readonly fetchImpl: typeof fetch;

  constructor(config: VoidlyPayConfig = {}) {
    this.did = config.did;
    this.apiBase = (config.apiBase || "https://api.voidly.ai").replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl || fetch.bind(globalThis);
    if (config.secretBase64) {
      const bytes = decodeBase64(config.secretBase64);
      if (bytes.length !== 64) {
        throw new Error("VoidlyPay: secretBase64 must decode to 64 bytes");
      }
      this.secret = bytes;
    }
  }

  // ─── Signing helpers ──────────────────────────────────────────────────

  sign(envelope: EnvelopeValue): string {
    if (!this.secret) {
      throw new Error("VoidlyPay: cannot sign without secretBase64 in config");
    }
    const bytes = canonicalBytes(envelope);
    const sig = nacl.sign.detached(bytes, this.secret);
    return encodeBase64(sig);
  }

  private requireDid(): string {
    if (!this.did) throw new Error("VoidlyPay: operation requires did in config");
    return this.did;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(this.apiBase + path);
    const body = (await res.json().catch(() => null)) as T;
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${JSON.stringify(body)}`);
    return body;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(this.apiBase + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as T;
    if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  // ─── Manifest + health + stats ────────────────────────────────────────

  manifest(): Promise<unknown> {
    return this.get("/v1/pay/manifest.json");
  }

  health(): Promise<{ system_frozen: boolean; counts?: Record<string, number> }> {
    return this.get("/v1/pay/health");
  }

  stats(): Promise<PayStats> {
    return this.get("/v1/pay/stats");
  }

  // ─── Wallet ───────────────────────────────────────────────────────────

  async ensureWallet(did?: string): Promise<WalletState> {
    const target = did || this.requireDid();
    await this.post("/v1/pay/wallet", { did: target });
    return this.wallet(target);
  }

  async wallet(did?: string): Promise<WalletState> {
    const target = did || this.requireDid();
    const body = await this.get<{ wallet: WalletState }>(`/v1/pay/wallet/${target}`);
    return body.wallet;
  }

  async history(did?: string, limit = 20, before?: string): Promise<unknown> {
    const target = did || this.requireDid();
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", before);
    return this.get(`/v1/pay/history/${target}?${q}`);
  }

  // ─── Faucet + trust ───────────────────────────────────────────────────

  async faucet(): Promise<{ ok: boolean; amount_micro?: number; new_balance_micro?: number; reason?: string }> {
    const did = this.requireDid();
    const envelope = {
      schema: "voidly-pay-faucet/v1",
      did,
      nonce: `sdk-faucet-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(10 * 60 * 1000),
    };
    return this.post("/v1/pay/faucet", { envelope, signature: this.sign(envelope) });
  }

  trust(did?: string): Promise<TrustSnapshot> {
    const target = did || this.requireDid();
    return this.get(`/v1/pay/trust/${target}`);
  }

  // ─── Transfer ─────────────────────────────────────────────────────────

  async pay(opts: {
    to: string;
    amountCredits?: number;
    amountMicro?: number;
    memo?: string;
    expiresInMinutes?: number;
  }): Promise<TransferReceipt> {
    const did = this.requireDid();
    const amountMicro =
      typeof opts.amountMicro === "number"
        ? opts.amountMicro
        : Math.round((opts.amountCredits || 0) * MICRO_PER_CREDIT);
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) {
      throw new Error("pay: amountCredits or amountMicro must resolve to a positive integer");
    }
    const expires = (opts.expiresInMinutes ?? 30) * 60 * 1000;
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-credit-transfer/v1",
      from_did: did,
      to_did: opts.to,
      amount_micro: amountMicro,
      nonce: `sdk-tx-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(expires),
    };
    if (opts.memo) envelope.memo = opts.memo;
    return this.post("/v1/pay/transfer", { envelope, signature: this.sign(envelope) });
  }

  // ─── Escrow ───────────────────────────────────────────────────────────

  async escrowOpen(opts: {
    to: string;
    amountCredits?: number;
    amountMicro?: number;
    deadlineHours?: number;
    memo?: string;
  }): Promise<EscrowOpenResult> {
    const did = this.requireDid();
    const amountMicro =
      typeof opts.amountMicro === "number"
        ? opts.amountMicro
        : Math.round((opts.amountCredits || 0) * MICRO_PER_CREDIT);
    const hours = Math.min(Math.max(1, opts.deadlineHours ?? 24), 168);
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-escrow-open/v1",
      from_did: did,
      to_did: opts.to,
      amount_micro: amountMicro,
      nonce: `sdk-esc-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(15 * 60 * 1000),
      deadline_at: isoOffset(hours * 60 * 60 * 1000),
    };
    if (opts.memo) envelope.memo = opts.memo;
    return this.post("/v1/pay/escrow/open", { envelope, signature: this.sign(envelope) });
  }

  async escrowRelease(escrowId: string): Promise<{ ok: boolean; reason?: string }> {
    const did = this.requireDid();
    const envelope = {
      schema: "voidly-escrow-release/v1",
      escrow_id: escrowId,
      signer_did: did,
      action_nonce: `sdk-rel-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(15 * 60 * 1000),
    };
    return this.post("/v1/pay/escrow/release", { envelope, signature: this.sign(envelope) });
  }

  async escrowRefund(escrowId: string, reason?: string): Promise<{ ok: boolean; reason?: string }> {
    const did = this.requireDid();
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-escrow-refund/v1",
      escrow_id: escrowId,
      signer_did: did,
      action_nonce: `sdk-ref-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(15 * 60 * 1000),
    };
    if (reason) envelope.reason = reason;
    return this.post("/v1/pay/escrow/refund", { envelope, signature: this.sign(envelope) });
  }

  escrow(id: string): Promise<{ escrow: unknown }> {
    return this.get(`/v1/pay/escrow/${id}`);
  }

  // ─── Capabilities (provider side) ────────────────────────────────────

  async capabilityList(opts: {
    capability: string;
    name: string;
    description: string;
    priceCredits?: number;
    pricePerCallMicro?: number;
    unit?: string;
    slaDeadlineHours?: number;
    tags?: string[];
    active?: boolean;
    inputSchema?: string;
    outputSchema?: string;
  }): Promise<{ ok: boolean; capability_id?: string; created?: boolean; reason?: string }> {
    const did = this.requireDid();
    const price =
      typeof opts.pricePerCallMicro === "number"
        ? opts.pricePerCallMicro
        : Math.round((opts.priceCredits || 0) * MICRO_PER_CREDIT);
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-capability-list/v1",
      provider_did: did,
      capability: opts.capability,
      name: opts.name,
      description: opts.description,
      price_per_call_micro: price,
      unit: opts.unit || "call",
      sla_deadline_hours: opts.slaDeadlineHours ?? 24,
      active: opts.active ?? true,
      nonce: `sdk-list-${opts.capability}-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(15 * 60 * 1000),
    };
    if (opts.inputSchema) envelope.input_schema = opts.inputSchema;
    if (opts.outputSchema) envelope.output_schema = opts.outputSchema;
    if (opts.tags && opts.tags.length) envelope.tags = JSON.stringify(opts.tags);
    return this.post("/v1/pay/capability/list", { envelope, signature: this.sign(envelope) });
  }

  async capabilitySearch(opts: {
    q?: string;
    capability?: string;
    maxPriceCredits?: number;
    maxPriceMicro?: number;
    providerDid?: string;
    limit?: number;
  } = {}): Promise<CapabilityListing[]> {
    const q = new URLSearchParams();
    if (opts.q) q.set("q", opts.q);
    if (opts.capability) q.set("capability", opts.capability);
    if (typeof opts.maxPriceMicro === "number") q.set("max_price_micro", String(opts.maxPriceMicro));
    else if (typeof opts.maxPriceCredits === "number")
      q.set("max_price_micro", String(Math.round(opts.maxPriceCredits * MICRO_PER_CREDIT)));
    if (opts.providerDid) q.set("provider_did", opts.providerDid);
    q.set("limit", String(Math.min(Math.max(1, opts.limit ?? 50), 200)));
    const body = await this.get<{ capabilities: CapabilityListing[] }>(`/v1/pay/capability/search?${q}`);
    return body.capabilities;
  }

  capability(id: string): Promise<{ capability: CapabilityListing }> {
    return this.get(`/v1/pay/capability/${id}`);
  }

  // ─── Hire (requester side) ───────────────────────────────────────────

  async hire(opts: {
    capabilityId: string;
    input?: string | object;
    taskId?: string;
    deliveryDeadlineHours?: number;
  }): Promise<HireResult> {
    const did = this.requireDid();
    const cap = (await this.capability(opts.capabilityId)).capability;
    if (cap.did === did) throw new Error("hire: cannot hire your own capability");
    const deliveryHours = Math.min(
      Math.max(1, opts.deliveryDeadlineHours ?? 24),
      Math.min(168, cap.sla_deadline_hours),
    );
    const inputJson =
      opts.input === undefined
        ? undefined
        : typeof opts.input === "string"
          ? opts.input
          : JSON.stringify(opts.input);
    if (inputJson && inputJson.length > 2048) throw new Error("hire: input must be ≤ 2048 chars");
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-hire-request/v1",
      capability_id: opts.capabilityId,
      capability: cap.capability,
      requester_did: did,
      provider_did: cap.did,
      price_micro: cap.price_per_call_micro,
      task_id: opts.taskId || `sdk-${uuidish()}`,
      delivery_deadline_hours: deliveryHours,
      nonce: `sdk-h-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(15 * 60 * 1000),
    };
    if (inputJson) envelope.input_json = inputJson;
    return this.post("/v1/pay/hire", { envelope, signature: this.sign(envelope) });
  }

  async hireGet(id: string): Promise<HireRow> {
    return (await this.get<{ hire: HireRow }>(`/v1/pay/hire/${id}`)).hire;
  }

  async hiresIncoming(state?: string, limit = 50, did?: string): Promise<HireRow[]> {
    const target = did || this.requireDid();
    const q = new URLSearchParams({ limit: String(limit) });
    if (state) q.set("state", state);
    const body = await this.get<{ hires: HireRow[] }>(`/v1/pay/hire/incoming/${target}?${q}`);
    return body.hires;
  }

  async hiresOutgoing(state?: string, limit = 50, did?: string): Promise<HireRow[]> {
    const target = did || this.requireDid();
    const q = new URLSearchParams({ limit: String(limit) });
    if (state) q.set("state", state);
    const body = await this.get<{ hires: HireRow[] }>(`/v1/pay/hire/outgoing/${target}?${q}`);
    return body.hires;
  }

  // ─── Work receipts ───────────────────────────────────────────────────

  async workClaim(opts: {
    escrowId?: string;
    taskId: string;
    requesterDid: string;
    workHash: string;
    summary?: string;
    acceptanceDeadlineHours?: number;
    autoAcceptOnTimeout?: boolean;
  }): Promise<{ ok: boolean; receipt_id?: string; state?: string; reason?: string }> {
    const did = this.requireDid();
    if (!/^[0-9a-f]{64}$/i.test(opts.workHash))
      throw new Error("workClaim: workHash must be 64-char sha256 hex");
    const now = Date.now();
    const hours = Math.min(Math.max(0.1, opts.acceptanceDeadlineHours ?? 24), 168);
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-work-claim/v1",
      task_id: opts.taskId,
      from_did: opts.requesterDid,
      to_did: did,
      work_hash: opts.workHash.toLowerCase(),
      nonce: `sdk-claim-${uuidish()}`,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
      acceptance_deadline_at: new Date(now + hours * 60 * 60 * 1000).toISOString(),
      auto_accept_on_timeout: opts.autoAcceptOnTimeout ?? true,
    };
    if (opts.escrowId) envelope.escrow_id = opts.escrowId;
    if (opts.summary) envelope.summary = opts.summary;
    return this.post("/v1/pay/receipt/claim", { envelope, signature: this.sign(envelope) });
  }

  async workAccept(receiptId: string, rating?: number, feedback?: string): Promise<{ ok: boolean; escrow_released?: boolean; reason?: string }> {
    const did = this.requireDid();
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-work-acceptance/v1",
      receipt_id: receiptId,
      signer_did: did,
      action: "accept",
      action_nonce: `sdk-acc-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(10 * 60 * 1000),
    };
    if (typeof rating === "number") envelope.rating = rating;
    if (feedback) envelope.feedback = feedback;
    return this.post("/v1/pay/receipt/accept", { envelope, signature: this.sign(envelope) });
  }

  async workDispute(receiptId: string, disputeReason: string, feedback?: string): Promise<{ ok: boolean; reason?: string }> {
    const did = this.requireDid();
    const envelope: Record<string, EnvelopeValue> = {
      schema: "voidly-work-acceptance/v1",
      receipt_id: receiptId,
      signer_did: did,
      action: "dispute",
      dispute_reason: disputeReason,
      action_nonce: `sdk-dis-${uuidish()}`,
      issued_at: nowIso(),
      expires_at: isoOffset(10 * 60 * 1000),
    };
    if (feedback) envelope.feedback = feedback;
    return this.post("/v1/pay/receipt/accept", { envelope, signature: this.sign(envelope) });
  }

  async receipt(id: string): Promise<WorkReceipt> {
    return (await this.get<{ receipt: WorkReceipt }>(`/v1/pay/receipt/${id}`)).receipt;
  }

  // ─── High-level convenience: hire → wait → verify → accept ──────────

  /**
   * Hire a capability, poll until the provider claims, optionally verify,
   * then accept (or dispute on verify-fail).
   */
  async hireAndWait(opts: {
    capabilityId: string;
    input?: string | object;
    deliveryDeadlineHours?: number;
    pollIntervalMs?: number;
    timeoutMs?: number;
    /** Optional verification — receives the receipt summary, returns true if accepted. */
    verify?: (summary: string | null, receipt: WorkReceipt) => boolean | Promise<boolean>;
    acceptRating?: number;
    disputeReason?: string;
  }): Promise<{ hire: HireRow; receipt: WorkReceipt; accepted: boolean; escrow_released?: boolean }> {
    const hireRes = await this.hire({
      capabilityId: opts.capabilityId,
      input: opts.input,
      deliveryDeadlineHours: opts.deliveryDeadlineHours,
    });
    if (!hireRes.ok || !hireRes.hire_id) {
      throw new Error(`hire failed: ${hireRes.reason || "unknown"}`);
    }

    const pollMs = opts.pollIntervalMs ?? 2000;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;

    let hire: HireRow | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      hire = await this.hireGet(hireRes.hire_id);
      if (hire.state === "claimed") break;
      if (hire.state === "expired" || hire.state === "completed" || hire.state === "disputed") break;
    }
    if (!hire || hire.state !== "claimed" || !hire.receipt_id) {
      throw new Error(`hire ${hireRes.hire_id} did not reach claimed state (got ${hire?.state})`);
    }

    const receipt = await this.receipt(hire.receipt_id);
    const ok = opts.verify
      ? await opts.verify(receipt.summary, receipt)
      : true;

    let escrowReleased: boolean | undefined;
    if (ok) {
      const r = await this.workAccept(receipt.id, opts.acceptRating ?? 5);
      escrowReleased = r.escrow_released;
    } else {
      await this.workDispute(receipt.id, opts.disputeReason || "verification failed");
    }

    return { hire, receipt, accepted: ok, escrow_released: escrowReleased };
  }

  /** Re-export of sha256Hex as an instance method for ergonomics. */
  sha256Hex(input: string | Uint8Array): Promise<string> {
    return sha256Hex(input);
  }
}

/** Convenience one-shot: create a keypair (for scripts that generate a fresh DID). */
export function generateKeyPair(): { did: string; publicKeyBase64: string; secretKeyBase64: string } {
  const kp = nacl.sign.keyPair();
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encodeBase58 = (bytes: Uint8Array): string => {
    if (bytes.length === 0) return "";
    const digits = [0];
    for (let i = 0; i < bytes.length; ++i) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; ++j) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    let leading = 0;
    for (let i = 0; i < bytes.length && bytes[i] === 0; ++i) leading++;
    let s = "";
    for (let i = 0; i < leading; ++i) s += ALPHABET[0];
    for (let i = digits.length - 1; i >= 0; --i) s += ALPHABET[digits[i]];
    return s;
  };
  return {
    did: "did:voidly:" + encodeBase58(kp.publicKey.slice(0, 16)),
    publicKeyBase64: encodeBase64(kp.publicKey),
    secretKeyBase64: encodeBase64(kp.secretKey),
  };
}

export default VoidlyPay;
