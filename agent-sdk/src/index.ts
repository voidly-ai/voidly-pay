/**
 * @voidly/agent-sdk — True E2E Encrypted Agent Communication
 *
 * All encryption and decryption happens CLIENT-SIDE.
 * The Voidly relay server NEVER sees private keys or plaintext.
 *
 * Crypto: X25519 + ML-KEM-768 hybrid key exchange, XSalsa20-Poly1305, Ed25519 signatures
 * Identity: did:voidly:{base58-encoded-ed25519-pubkey}
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { MlKem768 } from 'mlkem';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface AgentIdentity {
  did: string;
  apiKey: string;
  signingKeyPair: nacl.SignKeyPair;
  encryptionKeyPair: nacl.BoxKeyPair;
  /** ML-KEM-768 post-quantum keypair (optional — enables hybrid PQ encryption) */
  mlkemPublicKey?: Uint8Array;  // 1,184 bytes
  mlkemSecretKey?: Uint8Array;  // 2,400 bytes
}

export interface AgentProfile {
  did: string;
  name: string | null;
  signing_public_key: string;
  encryption_public_key: string;
  /** ML-KEM-768 public key (base64, 1184 bytes) — present if agent supports PQ */
  mlkem_public_key?: string;
  /** X3DH signed prekey bundle — enables async key agreement with offline agents */
  signed_prekey?: {
    public_key: string;
    signature: string;
    id: number;
  };
  capabilities: string[];
  message_count: number;
}

export interface DecryptedMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  contentType: string;
  messageType: string;
  threadId: string | null;
  replyTo: string | null;
  signatureValid: boolean;
  timestamp: string;
  expiresAt: string;
}

export interface SendResult {
  id: string;
  from: string;
  to: string;
  timestamp: string;
  expiresAt: string;
  encrypted: boolean;
  clientSide: boolean;
}

export interface VoidlyAgentConfig {
  baseUrl?: string;
  /** Enable transparent TOFU — auto-pin keys on first contact (default: true) */
  autoPin?: boolean;
  /** Default retry attempts for send() (default: 3) */
  retries?: number;
  /** Fallback relays — if primary fails, try these in order */
  fallbackRelays?: string[];
  /** Enable message padding to resist traffic analysis (default: true) */
  padding?: boolean;
  /** Enable sealed sender — hide sender DID from relay metadata (default: false) */
  sealedSender?: boolean;
  /** Reject messages with invalid signatures (default: false — returns signatureValid: false) */
  requireSignatures?: boolean;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Enable post-quantum hybrid encryption — ML-KEM-768 + X25519 (default: true) */
  postQuantum?: boolean;
  /** Enable deniable messaging — HMAC authentication instead of Ed25519 signatures (default: false) */
  deniable?: boolean;
  /** Enable Double Ratchet with DH ratchet for post-compromise recovery (default: true) */
  doubleRatchet?: boolean;
  /** Random delay range in ms before sending (metadata timing protection, default: 0 = disabled) */
  jitterMs?: number;
  /** Use long-poll for listen() instead of short-interval polling (default: true) */
  longPoll?: boolean;

  // ── Ratchet Persistence (v3.2) ────────────────────────────────────────────
  /** Auto-persist ratchet state after every send/receive (default: 'memory' = no persistence) */
  persist?: 'memory' | 'localStorage' | 'indexedDB' | 'file' | 'relay' | 'custom';
  /** Custom persistence: called after each ratchet step with encrypted blob */
  onPersist?: (encryptedState: string) => void | Promise<void>;
  /** Custom persistence: called on startup to load encrypted blob */
  onLoad?: () => string | null | Promise<string | null>;
  /** File path for persist: 'file' (Node.js environments only) */
  persistPath?: string;

  // ── Transport (v3.2) ──────────────────────────────────────────────────────
  /** Transport preference for listen() — tries in order, falls back automatically
   * Default: ['sse', 'long-poll']. Options: 'websocket' | 'sse' | 'long-poll' */
  transport?: ('websocket' | 'sse' | 'long-poll')[];

  // ── Ratchet Recovery (v3.3) ──────────────────────────────────────────────
  /** Auto-reset ratchet after N consecutive decrypt failures from same peer (default: 10, 0 = disabled) */
  autoResetThreshold?: number;
  /** Callback when a ratchet is auto-reset due to consecutive failures */
  onRatchetReset?: (peerDid: string, failCount: number) => void;
}

// ─── Listen & Conversation Types ─────────────────────────────────────────────

export interface ListenOptions {
  /** Milliseconds between polls (default: 2000, min: 500) */
  interval?: number;
  /** Only receive messages from this DID */
  from?: string;
  /** Only receive messages in this thread */
  threadId?: string;
  /** Only receive this message type */
  messageType?: string;
  /** Only receive unread messages (default: true) */
  unreadOnly?: boolean;
  /** Auto-mark messages as read after callback (default: true) */
  autoMarkRead?: boolean;
  /** Adaptive polling — reduce frequency when idle, speed up when active (default: true) */
  adaptive?: boolean;
  /** Send heartbeat pings while listening (default: true) */
  heartbeat?: boolean;
  /** Heartbeat interval in milliseconds (default: 60000 = 1 min) */
  heartbeatInterval?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface ListenHandle {
  /** Stop listening */
  stop: () => void;
  /** Whether the listener is active */
  readonly active: boolean;
}

export interface RetryOptions {
  /** Max retries (default: 3) */
  maxRetries?: number;
  /** Initial delay ms (default: 500) */
  baseDelay?: number;
  /** Max delay ms (default: 10000) */
  maxDelay?: number;
}

export interface ConversationMessage {
  id: string;
  from: string;
  content: string;
  timestamp: string;
  signatureValid: boolean;
  messageType: string;
}

export type MessageHandler = (message: DecryptedMessage) => void | Promise<void>;
export type ErrorHandler = (error: Error) => void;

// ─── Crypto Helpers ─────────────────────────────────────────────────────────────

async function sha256(data: string): Promise<string> {
  // Works in both Node.js and browsers
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const encoder = new TextEncoder();
    const hash = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(data));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Node.js fallback
  const { createHash } = await import('crypto');
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Pad message to nearest power-of-2 boundary (min 256 bytes).
 * Prevents traffic analysis via ciphertext length.
 * Format: [2-byte big-endian content length] [content] [random padding]
 */
function padMessage(content: Uint8Array): Uint8Array {
  const contentLen = content.length;
  const totalLen = Math.max(256, nextPowerOf2(contentLen + 2)); // +2 for length prefix
  const padded = new Uint8Array(totalLen);
  // Big-endian length prefix (supports up to 65535 bytes)
  padded[0] = (contentLen >> 8) & 0xff;
  padded[1] = contentLen & 0xff;
  padded.set(content, 2);
  // Fill remainder with random bytes (indistinguishable from ciphertext)
  const randomPad = nacl.randomBytes(totalLen - contentLen - 2);
  padded.set(randomPad, contentLen + 2);
  return padded;
}

function unpadMessage(padded: Uint8Array): Uint8Array {
  if (padded.length < 2) return padded; // Not padded
  const contentLen = (padded[0] << 8) | padded[1];
  if (contentLen + 2 > padded.length) return padded; // Not padded or corrupt
  return padded.slice(2, 2 + contentLen);
}

function nextPowerOf2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Derive a per-message key using HKDF-like hash ratchet.
 * Forward secrecy: knowing key[n] you cannot derive key[n-1].
 * chainKey[n+1] = SHA-256(chainKey[n] || 0x01)
 * messageKey[n] = SHA-256(chainKey[n] || 0x02)
 */
async function ratchetStep(chainKey: Uint8Array): Promise<{
  nextChainKey: Uint8Array;
  messageKey: Uint8Array;
}> {
  const encoder = new TextEncoder();
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const ckInput = new Uint8Array([...chainKey, 0x01]);
    const mkInput = new Uint8Array([...chainKey, 0x02]);
    const nextChainKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', ckInput));
    const messageKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', mkInput));
    return { nextChainKey, messageKey };
  }
  const { createHash } = await import('crypto');
  const nextChainKey = new Uint8Array(
    createHash('sha256').update(Buffer.from([...chainKey, 0x01])).digest()
  );
  const messageKey = new Uint8Array(
    createHash('sha256').update(Buffer.from([...chainKey, 0x02])).digest()
  );
  return { nextChainKey, messageKey };
}

/**
 * Sealed sender envelope.
 * The sender DID is encrypted INSIDE the message, not visible to the relay.
 * Format: { v: 2, from: senderDid, msg: originalPlaintext, ts: isoTimestamp }
 */
function sealEnvelope(
  senderDid: string,
  plaintext: string,
  meta?: { contentType?: string; messageType?: string; threadId?: string; replyTo?: string }
): string {
  const obj: Record<string, unknown> = {
    v: 3,
    from: senderDid,
    msg: plaintext,
    ts: new Date().toISOString(),
  };
  // Pack metadata INSIDE the ciphertext — relay never sees it
  if (meta?.contentType && meta.contentType !== 'text/plain') obj.ct = meta.contentType;
  if (meta?.messageType && meta.messageType !== 'text') obj.mt = meta.messageType;
  if (meta?.threadId) obj.tid = meta.threadId;
  if (meta?.replyTo) obj.rto = meta.replyTo;
  return JSON.stringify(obj);
}

interface UnsealedEnvelope {
  from: string;
  msg: string;
  ts: string;
  contentType?: string;
  messageType?: string;
  threadId?: string;
  replyTo?: string;
}

function unsealEnvelope(plaintext: string): UnsealedEnvelope | null {
  try {
    const parsed = JSON.parse(plaintext);
    if ((parsed.v === 2 || parsed.v === 3) && parsed.from && parsed.msg !== undefined) {
      const result: UnsealedEnvelope = { from: parsed.from, msg: parsed.msg, ts: parsed.ts };
      // Extract packed metadata (v3)
      if (parsed.ct) result.contentType = parsed.ct;
      if (parsed.mt) result.messageType = parsed.mt;
      if (parsed.tid) result.threadId = parsed.tid;
      if (parsed.rto) result.replyTo = parsed.rto;
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Protocol Header (v2.1) ────────────────────────────────────────────────────
// 4-byte header inside plaintext, BEFORE encryption:
// [0x56 'V'] [flags] [ratchet_step_hi] [ratchet_step_lo]
// flags: bit0=padded, bit1=sealed, bit2=ratcheted
const PROTO_MARKER = 0x56; // 'V'
const FLAG_PADDED     = 0x01;
const FLAG_SEALED     = 0x02;
const FLAG_RATCHET    = 0x04;
const FLAG_PQ         = 0x08; // Post-quantum hybrid (ML-KEM-768 + X25519)
const FLAG_DH_RATCHET = 0x10; // Double Ratchet — DH ratchet key in envelope (post-compromise recovery)
const FLAG_DENIABLE   = 0x20; // Deniable authentication (HMAC instead of Ed25519 signature)

function makeProtoHeader(flags: number, ratchetStep: number): Uint8Array {
  return new Uint8Array([PROTO_MARKER, flags, (ratchetStep >> 8) & 0xff, ratchetStep & 0xff]);
}

function parseProtoHeader(data: Uint8Array): { flags: number; ratchetStep: number; content: Uint8Array } | null {
  if (data.length < 4 || data[0] !== PROTO_MARKER) return null;
  return {
    flags: data[1],
    ratchetStep: (data[2] << 8) | data[3],
    content: data.slice(4),
  };
}

// ─── Double Ratchet KDF ─────────────────────────────────────────────────────────
// KDF_RK: Root Key ratchet step — mixes DH output into root chain
// Returns new root key + chain key (post-compromise recovery)
async function kdfRK(rootKey: Uint8Array, dhOutput: Uint8Array): Promise<{ newRootKey: Uint8Array; newChainKey: Uint8Array }> {
  const combined = new Uint8Array(rootKey.length + dhOutput.length);
  combined.set(rootKey, 0);
  combined.set(dhOutput, rootKey.length);
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const prk = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', combined.buffer as ArrayBuffer));
    const newRootKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array([...prk, 0x01]).buffer as ArrayBuffer));
    const newChainKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array([...prk, 0x02]).buffer as ArrayBuffer));
    return { newRootKey, newChainKey };
  }
  const { createHash } = await import('crypto');
  const prk = new Uint8Array(createHash('sha256').update(Buffer.from(combined)).digest());
  const newRootKey = new Uint8Array(createHash('sha256').update(Buffer.from([...prk, 0x01])).digest());
  const newChainKey = new Uint8Array(createHash('sha256').update(Buffer.from([...prk, 0x02])).digest());
  return { newRootKey, newChainKey };
}

// HMAC-SHA256 for deniable authentication (replaces Ed25519 signature)
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', key.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, data.buffer as ArrayBuffer));
  }
  const { createHmac } = await import('crypto');
  return new Uint8Array(createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest());
}

// ─── Ratchet State ──────────────────────────────────────────────────────────────

interface RatchetPeerState {
  // Sending chain (I → peer)
  sendChainKey: Uint8Array;
  sendStep: number;
  // Receiving chain (peer → I)
  recvChainKey: Uint8Array;
  recvStep: number;
  // Skipped message keys for out-of-order delivery (step → messageKey)
  skippedKeys: Map<number, Uint8Array>;
  // ── Double Ratchet extension (v3 — post-compromise recovery) ──
  // When present, DH ratchet is active on top of hash ratchet
  rootKey?: Uint8Array;                // Root key (32 bytes) — input to KDF_RK
  dhSendKeyPair?: nacl.BoxKeyPair;     // Our current DH ratchet keypair
  dhRecvPubKey?: Uint8Array;           // Their current DH ratchet public key
  prevSendStep?: number;               // Previous sending chain length (for skip tracking)
  dhSkippedKeys?: Map<string, Uint8Array>; // "base64DhPub:step" → messageKey
}

const MAX_SKIP = 1000; // Max skipped keys to cache (Signal uses 2000)

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '1';
  let result = '';
  let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    result = BASE58_ALPHABET[Number(remainder)] + result;
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result || '1';
}

// ─── VoidlyAgent Class ─────────────────────────────────────────────────────────

/**
 * A Voidly Agent with client-side encryption.
 * Private keys NEVER leave this process.
 *
 * @example
 * ```ts
 * import { VoidlyAgent } from '@voidly/agent-sdk';
 *
 * // Register a new agent
 * const agent = await VoidlyAgent.register({ name: 'my-agent' });
 * console.log(agent.did); // did:voidly:...
 *
 * // Send an encrypted message
 * await agent.send('did:voidly:recipient', 'Hello, securely!');
 *
 * // Receive and decrypt messages
 * const messages = await agent.receive();
 * ```
 */
export class VoidlyAgent {
  readonly did: string;
  readonly apiKey: string;
  private signingKeyPair: nacl.SignKeyPair;
  private encryptionKeyPair: nacl.BoxKeyPair;
  private baseUrl: string;
  private autoPin: boolean;
  private defaultRetries: number;
  private fallbackRelays: string[];
  private paddingEnabled: boolean;
  private sealedSender: boolean;
  private requireSignatures: boolean;
  private timeout: number;
  private postQuantum: boolean;
  private deniable: boolean;
  private doubleRatchet: boolean;
  private jitterMs: number;
  private longPoll: boolean;
  private mlkemPublicKey: Uint8Array | null;
  private mlkemSecretKey: Uint8Array | null;
  private _signedPrekey: nacl.BoxKeyPair | null = null;
  private _signedPrekeyId: number = 0;
  private _pinnedDids: Set<string> = new Set();
  private _listeners: Set<{ stop: () => void }> = new Set();
  private _conversations: Map<string, Conversation> = new Map();
  private _offlineQueue: Array<{ recipientDid: string; message: string; options: Record<string, unknown>; timestamp: number }> = [];
  private _ratchetStates: Map<string, RatchetPeerState> = new Map();
  private _identityCache: Map<string, { profile: AgentProfile; cachedAt: number }> = new Map();
  private _seenMessageIds: Set<string> = new Set();
  private _decryptFailCount: number = 0;
  /** Per-peer consecutive decrypt failure tracking for auto-recovery */
  private _peerDecryptFails: Map<string, number> = new Map();
  /** Max consecutive per-peer decrypt failures before auto-resetting ratchet (0 = disabled) */
  private _autoResetThreshold: number = 10;
  // RPC handlers: method → handler function
  private _rpcHandlers: Map<string, (params: any, caller: string) => Promise<any>> = new Map();
  // RPC pending responses: rpc_id → { resolve, reject, timer }
  private _rpcPending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  // Cover traffic state
  private _coverTrafficTimer: ReturnType<typeof setInterval> | null = null;
  // RPC listener handle (started on first onInvoke)
  private _rpcListener: { stop: () => void } | null = null;
  // Persistence (v3.2)
  private _persistMode: string = 'memory';
  private _onPersist?: (data: string) => void | Promise<void>;
  private _onLoad?: () => string | null | Promise<string | null>;
  private _persistPath?: string;
  private _persistKey: Uint8Array | null = null;
  // Transport preference (v3.2)
  private _transportPrefs: string[];
  // Ratchet recovery callback (v3.3)
  private _onRatchetReset?: (peerDid: string, failCount: number) => void;
  // v3.4.2: Per-peer send mutex — prevents concurrent send() from deriving identical chain keys
  private _sendLocks: Map<string, Promise<void>> = new Map();
  // v3.4.2: Global decrypt mutex — prevents concurrent _decryptMessages from corrupting ratchet state
  private _decryptLock: Promise<void> | null = null;

  private constructor(identity: AgentIdentity, config?: VoidlyAgentConfig) {
    this.did = identity.did;
    this.apiKey = identity.apiKey;
    this.signingKeyPair = identity.signingKeyPair;
    this.encryptionKeyPair = identity.encryptionKeyPair;
    this.baseUrl = config?.baseUrl || 'https://api.voidly.ai';
    this.autoPin = config?.autoPin !== false; // default true
    this.defaultRetries = config?.retries ?? 3;
    this.fallbackRelays = config?.fallbackRelays || [];
    this.paddingEnabled = config?.padding !== false; // default true
    this.sealedSender = config?.sealedSender || false;
    this.requireSignatures = config?.requireSignatures || false;
    this.timeout = config?.timeout ?? 30000;
    this.postQuantum = config?.postQuantum !== false; // default true
    this.deniable = config?.deniable || false;
    this.doubleRatchet = config?.doubleRatchet !== false; // default true
    this.jitterMs = config?.jitterMs || 0;
    this.longPoll = config?.longPoll !== false; // default true
    this.mlkemPublicKey = identity.mlkemPublicKey || null;
    this.mlkemSecretKey = identity.mlkemSecretKey || null;
    // Persistence
    this._persistMode = config?.persist || 'memory';
    this._onPersist = config?.onPersist;
    this._onLoad = config?.onLoad;
    this._persistPath = config?.persistPath;
    // Transport
    this._transportPrefs = config?.transport || ['sse', 'long-poll'];
    // Ratchet recovery
    this._autoResetThreshold = config?.autoResetThreshold ?? 10;
    this._onRatchetReset = config?.onRatchetReset;
  }

  // ─── Factory Methods ────────────────────────────────────────────────────────

  /**
   * Register a new agent on the Voidly relay.
   * Keys are generated locally — the server only receives public keys.
   */
  static async register(
    options: { name?: string; capabilities?: string[] } = {},
    config?: VoidlyAgentConfig
  ): Promise<VoidlyAgent> {
    const baseUrl = config?.baseUrl || 'https://api.voidly.ai';

    // Generate keypairs locally
    const signingKeyPair = nacl.sign.keyPair();
    const encryptionKeyPair = nacl.box.keyPair();

    // Generate ML-KEM-768 post-quantum keypair (NIST FIPS 203)
    const usePQ = config?.postQuantum !== false;
    let mlkemPk: Uint8Array | undefined;
    let mlkemSk: Uint8Array | undefined;
    if (usePQ) {
      const kem = new MlKem768();
      [mlkemPk, mlkemSk] = await kem.generateKeyPair();
    }

    // Generate X3DH signed prekey (medium-term DH key for async key agreement)
    const signedPrekeyPair = nacl.box.keyPair();
    const signedPrekeyId = 1;
    // Sign the prekey with our identity signing key (proves it's ours)
    const prekeySignature = nacl.sign.detached(signedPrekeyPair.publicKey, signingKeyPair.secretKey);

    // Register with relay (only public keys sent — server NEVER has private keys)
    const regBody: Record<string, unknown> = {
      name: options.name,
      capabilities: options.capabilities,
      signing_public_key: encodeBase64(signingKeyPair.publicKey),
      encryption_public_key: encodeBase64(encryptionKeyPair.publicKey),
      // X3DH signed prekey
      signed_prekey_public: encodeBase64(signedPrekeyPair.publicKey),
      signed_prekey_signature: encodeBase64(prekeySignature),
      signed_prekey_id: signedPrekeyId,
    };
    if (mlkemPk) {
      regBody.mlkem_public_key = encodeBase64(mlkemPk);
    }
    const res = await fetch(`${baseUrl}/v1/agent/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(regBody),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errMsg = (err as any).error?.message || (err as any).error || res.statusText;
      throw new Error(`Registration failed: ${errMsg}`);
    }

    const data = await res.json() as { did: string; api_key: string };

    const agent = new VoidlyAgent({
      did: data.did,
      apiKey: data.api_key,
      signingKeyPair,
      encryptionKeyPair,
      mlkemPublicKey: mlkemPk,
      mlkemSecretKey: mlkemSk,
    }, config);
    agent._signedPrekey = signedPrekeyPair;
    agent._signedPrekeyId = signedPrekeyId;
    return agent;
  }

  /**
   * Restore an agent from saved credentials.
   * Use this to resume an agent across sessions.
   */
  static fromCredentials(creds: {
    did: string;
    apiKey: string;
    signingSecretKey: string;   // base64
    encryptionSecretKey: string; // base64
    ratchetStates?: Record<string, {
      sendChainKey: string; sendStep: number; recvChainKey: string; recvStep: number;
      rootKey?: string; dhSendSecretKey?: string; dhSendPublicKey?: string;
      dhRecvPubKey?: string; prevSendStep?: number;
      skippedKeys?: Record<string, string>; dhSkippedKeys?: Record<string, string>;
    }>;
    mlkemPublicKey?: string;
    mlkemSecretKey?: string;
    signedPrekeySecret?: string;
    signedPrekeyPublic?: string;
    signedPrekeyId?: number;
    peerDecryptFails?: Record<string, number>;
  }, config?: VoidlyAgentConfig): VoidlyAgent {
    // Validate required fields
    if (!creds.did || !creds.did.startsWith('did:')) {
      throw new Error('Invalid credentials: did must start with "did:"');
    }
    if (!creds.apiKey || creds.apiKey.length < 8) {
      throw new Error('Invalid credentials: apiKey is missing or too short');
    }
    if (!creds.signingSecretKey || !creds.encryptionSecretKey) {
      throw new Error('Invalid credentials: secret keys are required');
    }

    let signingSecret: Uint8Array;
    let encryptionSecret: Uint8Array;
    try {
      signingSecret = decodeBase64(creds.signingSecretKey);
      encryptionSecret = decodeBase64(creds.encryptionSecretKey);
    } catch {
      throw new Error('Invalid credentials: secret keys must be valid base64');
    }

    if (signingSecret.length !== 64) {
      throw new Error(`Invalid credentials: signing key must be 64 bytes, got ${signingSecret.length}`);
    }
    if (encryptionSecret.length !== 32) {
      throw new Error(`Invalid credentials: encryption key must be 32 bytes, got ${encryptionSecret.length}`);
    }

    // Restore ML-KEM keys if present
    let mlkemPk: Uint8Array | undefined;
    let mlkemSk: Uint8Array | undefined;
    if (creds.mlkemPublicKey && creds.mlkemSecretKey) {
      try {
        mlkemPk = decodeBase64(creds.mlkemPublicKey);
        mlkemSk = decodeBase64(creds.mlkemSecretKey);
        if (mlkemPk.length !== 1184 || mlkemSk.length !== 2400) {
          mlkemPk = undefined;
          mlkemSk = undefined;
        }
      } catch {
        // Invalid ML-KEM keys — ignore
      }
    }

    // If ML-KEM secret key is missing, auto-disable postQuantum to prevent sending
    // PQ-encrypted messages that the recipient can't decrypt (asymmetric PQ = desync).
    // The receiver-side fallback to X25519 still works for incoming PQ messages.
    const effectiveConfig = (!mlkemSk && config?.postQuantum !== false)
      ? { ...config, postQuantum: false }
      : config;

    const agent = new VoidlyAgent({
      did: creds.did,
      apiKey: creds.apiKey,
      signingKeyPair: nacl.sign.keyPair.fromSecretKey(signingSecret),
      encryptionKeyPair: {
        publicKey: nacl.box.keyPair.fromSecretKey(encryptionSecret).publicKey,
        secretKey: encryptionSecret,
      },
      mlkemPublicKey: mlkemPk,
      mlkemSecretKey: mlkemSk,
    }, effectiveConfig);

    // Restore ratchet states for forward secrecy session continuity
    if (creds.ratchetStates) {
      for (const [pairId, rs] of Object.entries(creds.ratchetStates)) {
        try {
          const sendChainKey = decodeBase64(rs.sendChainKey);
          const recvChainKey = decodeBase64(rs.recvChainKey);
          if (sendChainKey.length !== 32 || recvChainKey.length !== 32) continue;
          const state: RatchetPeerState = {
            sendChainKey,
            sendStep: rs.sendStep || 0,
            recvChainKey,
            recvStep: rs.recvStep || 0,
            skippedKeys: new Map(),
          };
          // Restore Double Ratchet DH state if present
          if (rs.rootKey) {
            try {
              state.rootKey = decodeBase64(rs.rootKey);
              if (state.rootKey.length !== 32) state.rootKey = undefined;
            } catch { /* ignore */ }
          }
          if (rs.dhSendSecretKey && rs.dhSendPublicKey) {
            try {
              const sk = decodeBase64(rs.dhSendSecretKey);
              const pk = decodeBase64(rs.dhSendPublicKey);
              if (sk.length === 32 && pk.length === 32) {
                state.dhSendKeyPair = { publicKey: pk, secretKey: sk };
              }
            } catch { /* ignore */ }
          }
          if (rs.dhRecvPubKey) {
            try {
              const pk = decodeBase64(rs.dhRecvPubKey);
              if (pk.length === 32) state.dhRecvPubKey = pk;
            } catch { /* ignore */ }
          }
          if (rs.prevSendStep !== undefined) state.prevSendStep = rs.prevSendStep;
          state.dhSkippedKeys = new Map();
          // Restore skipped message keys (out-of-order message recovery)
          if (rs.skippedKeys && typeof rs.skippedKeys === 'object') {
            for (const [step, keyB64] of Object.entries(rs.skippedKeys)) {
              try {
                const mk = decodeBase64(keyB64 as string);
                if (mk.length === 32) state.skippedKeys.set(Number(step), mk);
              } catch { /* ignore */ }
            }
          }
          if (rs.dhSkippedKeys && typeof rs.dhSkippedKeys === 'object') {
            for (const [label, keyB64] of Object.entries(rs.dhSkippedKeys)) {
              try {
                const mk = decodeBase64(keyB64 as string);
                if (mk.length === 32) state.dhSkippedKeys.set(label, mk);
              } catch { /* ignore */ }
            }
          }
          agent._ratchetStates.set(pairId, state);
        } catch {
          // Skip invalid ratchet state entries silently
        }
      }
    }

    // Restore per-peer decrypt fail counter (survives app restarts)
    if (creds.peerDecryptFails && typeof creds.peerDecryptFails === 'object') {
      for (const [peer, count] of Object.entries(creds.peerDecryptFails)) {
        if (typeof count === 'number' && count > 0) {
          agent._peerDecryptFails.set(peer, count);
        }
      }
    }

    // Restore signed prekey for X3DH
    if (creds.signedPrekeySecret && creds.signedPrekeyPublic) {
      try {
        const sk = decodeBase64(creds.signedPrekeySecret);
        const pk = decodeBase64(creds.signedPrekeyPublic);
        if (sk.length === 32 && pk.length === 32) {
          agent._signedPrekey = { publicKey: pk, secretKey: sk };
          agent._signedPrekeyId = creds.signedPrekeyId || 0;
        }
      } catch { /* ignore */ }
    }

    return agent;
  }

  /**
   * Export credentials for persistence.
   * Store these securely — they contain private keys.
   */
  exportCredentials(): {
    did: string;
    apiKey: string;
    signingSecretKey: string;
    encryptionSecretKey: string;
    signingPublicKey: string;
    encryptionPublicKey: string;
    ratchetStates?: Record<string, {
      sendChainKey: string; sendStep: number; recvChainKey: string; recvStep: number;
      rootKey?: string; dhSendSecretKey?: string; dhSendPublicKey?: string;
      dhRecvPubKey?: string; prevSendStep?: number;
      skippedKeys?: Record<string, string>; dhSkippedKeys?: Record<string, string>;
    }>;
    mlkemPublicKey?: string;
    mlkemSecretKey?: string;
    signedPrekeySecret?: string;
    signedPrekeyPublic?: string;
    signedPrekeyId?: number;
    peerDecryptFails?: Record<string, number>;
  } {
    // Export ratchet states for session persistence (includes Double Ratchet DH state)
    const ratchetStates: Record<string, any> = {};
    for (const [pairId, state] of this._ratchetStates) {
      const rs: any = {
        sendChainKey: encodeBase64(state.sendChainKey),
        sendStep: state.sendStep,
        recvChainKey: encodeBase64(state.recvChainKey),
        recvStep: state.recvStep,
      };
      // Double Ratchet DH state
      if (state.rootKey) rs.rootKey = encodeBase64(state.rootKey);
      if (state.dhSendKeyPair) {
        rs.dhSendSecretKey = encodeBase64(state.dhSendKeyPair.secretKey);
        rs.dhSendPublicKey = encodeBase64(state.dhSendKeyPair.publicKey);
      }
      if (state.dhRecvPubKey) rs.dhRecvPubKey = encodeBase64(state.dhRecvPubKey);
      if (state.prevSendStep !== undefined) rs.prevSendStep = state.prevSendStep;
      // Export skipped message keys (out-of-order message recovery)
      if (state.skippedKeys?.size) {
        rs.skippedKeys = Object.fromEntries(
          [...state.skippedKeys].map(([step, key]) => [String(step), encodeBase64(key)])
        );
      }
      if (state.dhSkippedKeys?.size) {
        rs.dhSkippedKeys = Object.fromEntries(
          [...state.dhSkippedKeys].map(([label, key]) => [label, encodeBase64(key)])
        );
      }
      ratchetStates[pairId] = rs;
    }

    return {
      did: this.did,
      apiKey: this.apiKey,
      signingSecretKey: encodeBase64(this.signingKeyPair.secretKey),
      encryptionSecretKey: encodeBase64(this.encryptionKeyPair.secretKey),
      signingPublicKey: encodeBase64(this.signingKeyPair.publicKey),
      encryptionPublicKey: encodeBase64(this.encryptionKeyPair.publicKey),
      ...(Object.keys(ratchetStates).length > 0 ? { ratchetStates } : {}),
      ...(this.mlkemPublicKey ? { mlkemPublicKey: encodeBase64(this.mlkemPublicKey) } : {}),
      ...(this.mlkemSecretKey ? { mlkemSecretKey: encodeBase64(this.mlkemSecretKey) } : {}),
      ...(this._signedPrekey ? {
        signedPrekeySecret: encodeBase64(this._signedPrekey.secretKey),
        signedPrekeyPublic: encodeBase64(this._signedPrekey.publicKey),
        signedPrekeyId: this._signedPrekeyId,
      } : {}),
      // Persist per-peer decrypt fail counter across restarts
      ...(this._peerDecryptFails.size > 0 ? {
        peerDecryptFails: Object.fromEntries(this._peerDecryptFails),
      } : {}),
    };
  }

  // ─── Ratchet Persistence (v3.2) ────────────────────────────────────────────

  /** Derive persistence encryption key from signing secret */
  private _derivePersistKey(): Uint8Array {
    if (this._persistKey) return this._persistKey;
    const salt = decodeUTF8('voidly-persist-v1');
    const input = new Uint8Array(this.signingKeyPair.secretKey.length + salt.length);
    input.set(this.signingKeyPair.secretKey, 0);
    input.set(salt, this.signingKeyPair.secretKey.length);
    // nacl.hash = SHA-512, take first 32 bytes for secretbox key
    this._persistKey = nacl.hash(input).slice(0, 32);
    return this._persistKey;
  }

  /** Auto-persist ratchet state (called after every ratchet mutation) */
  private async _persistRatchetState(): Promise<void> {
    if (this._persistMode === 'memory') return;
    try {
      const creds = this.exportCredentials();
      const data = JSON.stringify(creds.ratchetStates || {});
      const key = this._derivePersistKey();
      const nonce = nacl.randomBytes(24);
      const encrypted = nacl.secretbox(decodeUTF8(data), nonce, key);
      const blob = JSON.stringify({ n: encodeBase64(nonce), c: encodeBase64(encrypted), v: 1 });

      switch (this._persistMode) {
        case 'localStorage':
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(`voidly-ratchet-${this.did}`, blob);
          }
          break;
        case 'indexedDB':
          await this._idbPut(blob);
          break;
        case 'file':
          if (this._persistPath) {
            const fs = await import('fs/promises');
            await fs.writeFile(this._persistPath, blob, 'utf-8');
          }
          break;
        case 'relay':
          await this._timedFetch(`${this.baseUrl}/v1/agent/memory/ratchet/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
            body: JSON.stringify({ value: blob }),
          }).catch((e: unknown) => {
            console.warn(`[voidly] ⚠ Relay ratchet persist failed: ${e instanceof Error ? e.message : e}`);
          });
          break;
        case 'custom':
          if (this._onPersist) await this._onPersist(blob);
          break;
      }
    } catch (e) {
      console.warn(`[voidly] ⚠ Ratchet state persistence failed (${this._persistMode}): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Load persisted ratchet state and restore into memory */
  private async _loadPersistedRatchetState(): Promise<void> {
    if (this._persistMode === 'memory') return;
    let blob: string | null = null;
    try {
      switch (this._persistMode) {
        case 'localStorage':
          if (typeof localStorage !== 'undefined') {
            blob = localStorage.getItem(`voidly-ratchet-${this.did}`);
          }
          break;
        case 'indexedDB':
          blob = await this._idbGet();
          break;
        case 'file':
          if (this._persistPath) {
            try {
              const fs = await import('fs/promises');
              blob = await fs.readFile(this._persistPath, 'utf-8');
            } catch { /* file doesn't exist yet */ }
          }
          break;
        case 'relay':
          try {
            const res = await this._timedFetch(`${this.baseUrl}/v1/agent/memory/ratchet/state`, {
              headers: { 'X-Agent-Key': this.apiKey },
            });
            if (res.ok) {
              const data = await res.json() as any;
              blob = data.value;
            }
          } catch (e) {
            console.warn(`[voidly] ⚠ Relay ratchet load failed: ${e instanceof Error ? e.message : e}`);
          }
          break;
        case 'custom':
          if (this._onLoad) blob = await this._onLoad();
          break;
      }
    } catch (e) {
      console.warn(`[voidly] ⚠ Ratchet state load failed (${this._persistMode}): ${e instanceof Error ? e.message : e}`);
      return;
    }

    if (!blob) return;
    try {
      const { n, c } = JSON.parse(blob);
      const key = this._derivePersistKey();
      const decrypted = nacl.secretbox.open(decodeBase64(c), decodeBase64(n), key);
      if (!decrypted) return;
      const states = JSON.parse(encodeUTF8(decrypted));
      for (const [pairId, rs] of Object.entries(states) as [string, any][]) {
        // Validate required fields exist and are correct type
        if (!rs || typeof rs.sendStep !== 'number' || typeof rs.recvStep !== 'number'
            || typeof rs.sendChainKey !== 'string' || typeof rs.recvChainKey !== 'string') {
          continue; // skip malformed entry
        }
        // Bounds-check step counters
        if (rs.sendStep < 0 || rs.recvStep < 0 || rs.sendStep > 0xFFFFFFFF || rs.recvStep > 0xFFFFFFFF) {
          continue;
        }

        // If credentials already loaded a state for this peer, keep whichever is
        // more advanced (higher total steps = more recent). This prevents the dual
        // persistence conflict where the messenger's 8-second-stale credentials
        // overwrite the SDK's near-realtime IndexedDB state.
        if (this._ratchetStates.has(pairId)) {
          const existing = this._ratchetStates.get(pairId)!;
          const existingSteps = existing.sendStep + existing.recvStep;
          const persistedSteps = (rs.sendStep || 0) + (rs.recvStep || 0);
          if (persistedSteps <= existingSteps) {
            continue; // Credentials state is newer or equal — keep it
          }
          // Persisted state is more advanced — fall through to overwrite
        }

        const state: RatchetPeerState = {
          sendChainKey: decodeBase64(rs.sendChainKey),
          sendStep: rs.sendStep,
          recvChainKey: decodeBase64(rs.recvChainKey),
          recvStep: rs.recvStep,
          skippedKeys: new Map(),
        };
        if (rs.rootKey && typeof rs.rootKey === 'string') state.rootKey = decodeBase64(rs.rootKey);
        if (typeof rs.dhSendSecretKey === 'string' && typeof rs.dhSendPublicKey === 'string') {
          state.dhSendKeyPair = {
            secretKey: decodeBase64(rs.dhSendSecretKey),
            publicKey: decodeBase64(rs.dhSendPublicKey),
          };
        }
        if (typeof rs.dhRecvPubKey === 'string') state.dhRecvPubKey = decodeBase64(rs.dhRecvPubKey);
        if (typeof rs.prevSendStep === 'number' && rs.prevSendStep >= 0) state.prevSendStep = rs.prevSendStep;
        // Validate key sizes (all NaCl keys must be 32 bytes)
        if (state.sendChainKey.length === 32 && state.recvChainKey.length === 32) {
          this._ratchetStates.set(pairId, state);
        }
      }
    } catch (e) {
      console.warn(`[voidly] ⚠ Ratchet state restore failed (corrupt data, starting fresh): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** IndexedDB put helper (browser only) */
  private async _idbPut(blob: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('voidly-agent', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ratchet')) db.createObjectStore('ratchet');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('ratchet', 'readwrite');
        tx.objectStore('ratchet').put(blob, this.did);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** IndexedDB get helper (browser only) */
  private async _idbGet(): Promise<string | null> {
    if (typeof indexedDB === 'undefined') return null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('voidly-agent', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ratchet')) db.createObjectStore('ratchet');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('ratchet', 'readonly');
        const getReq = tx.objectStore('ratchet').get(this.did);
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => reject(getReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Force-persist current ratchet state.
   * Useful to call before process exit to ensure state is saved.
   */
  async flushRatchetState(): Promise<void> {
    const origMode = this._persistMode;
    if (origMode === 'memory') this._persistMode = 'file'; // force a write
    await this._persistRatchetState();
    this._persistMode = origMode;
  }

  /**
   * Restore an agent from credentials with async persistence loading.
   * Use this instead of `fromCredentials()` when using file/relay/custom persistence.
   */
  static async fromCredentialsAsync(
    creds: Parameters<typeof VoidlyAgent.fromCredentials>[0],
    config?: VoidlyAgentConfig
  ): Promise<VoidlyAgent> {
    const agent = VoidlyAgent.fromCredentials(creds, config);
    await agent._loadPersistedRatchetState();
    return agent;
  }

  /**
   * Get the number of messages that failed to decrypt.
   * Useful for detecting key mismatches, attacks, or corruption.
   */
  get decryptFailCount(): number {
    return this._decryptFailCount;
  }

  /**
   * Get per-peer consecutive decrypt failure counts.
   * Useful for diagnosing which peer conversations have desynchronized ratchets.
   */
  get peerDecryptFails(): Record<string, number> {
    return Object.fromEntries(this._peerDecryptFails);
  }

  /**
   * Reset ratchet state for a specific peer.
   * This clears all ratchet keys for the conversation, causing the next send
   * to re-initialize a fresh DH exchange. The peer's ratchet will also reset
   * automatically when they receive the new-format message.
   *
   * Use this when ratchet desync is detected (e.g., consecutive decrypt failures).
   * After calling this, both sides need to send a message to re-establish the ratchet.
   *
   * @param peerDid - The DID of the peer whose ratchet should be reset
   * @returns true if a ratchet was found and reset, false if no ratchet existed
   */
  resetRatchet(peerDid: string): boolean {
    // Clear both directions: we→peer (send state) and peer→we (recv state)
    const sendPairId = `${this.did}:${peerDid}`;
    const recvPairId = `${peerDid}:${this.did}`;
    const hadSend = this._ratchetStates.delete(sendPairId);
    const hadRecv = this._ratchetStates.delete(recvPairId);
    // Reset per-peer failure counter
    this._peerDecryptFails.delete(peerDid);
    // Persist the cleared state
    if (hadSend || hadRecv) {
      this._persistRatchetState().catch(() => {});
    }
    return hadSend || hadRecv;
  }

  /**
   * Generate a did:key identifier from this agent's Ed25519 signing key.
   * did:key is a W3C standard — interoperable across systems.
   * Format: did:key:z6Mk{base58-multicodec-ed25519-pubkey}
   */
  get didKey(): string {
    // Multicodec prefix for Ed25519 public key: 0xed01
    const multicodec = new Uint8Array(2 + this.signingKeyPair.publicKey.length);
    multicodec[0] = 0xed;
    multicodec[1] = 0x01;
    multicodec.set(this.signingKeyPair.publicKey, 2);
    return `did:key:z${toBase58(multicodec)}`;
  }

  // ─── Messaging ──────────────────────────────────────────────────────────────

  /**
   * Send an E2E encrypted message with hardened security.
   * Encryption happens locally — the relay NEVER sees plaintext or private keys.
   *
   * Security features:
   * - **Message padding** — ciphertext padded to power-of-2 boundary (traffic analysis resistance)
   * - **Hash ratchet** — per-conversation forward secrecy (compromise key[n] can't derive key[n-1])
   * - **Sealed sender** — optionally hide sender DID from relay metadata
   * - **Auto-retry** with exponential backoff on transient failures
   * - **Multi-relay fallback** — try backup relays if primary is down
   * - **Offline queue** — queue messages if all relays fail
   * - **Transparent TOFU** — auto-pin recipient keys on first contact
   */
  async send(
    recipientDid: string,
    message: string,
    options: {
      contentType?: string;
      threadId?: string;
      replyTo?: string;
      ttl?: number;
      messageType?: string;
      /** Override default retry count (0 = no retry) */
      retries?: number;
      /** Skip auto key pinning for this message */
      skipPin?: boolean;
      /** Force sealed sender for this message */
      sealedSender?: boolean;
      /** Disable padding for this message */
      noPadding?: boolean;
    } = {}
  ): Promise<SendResult> {
    // v3.4.2: Per-peer send mutex — two concurrent send() calls to the same peer
    // would read the SAME sendChainKey, derive the SAME messageKey, encrypt
    // different messages with identical keys → forward secrecy break + one
    // message undecryptable by peer.
    const lockKey = `send:${recipientDid}`;
    while (this._sendLocks.has(lockKey)) {
      await this._sendLocks.get(lockKey);
    }
    let unlockSend!: () => void;
    this._sendLocks.set(lockKey, new Promise<void>(r => { unlockSend = r; }));
    try {
      return await this._sendInner(recipientDid, message, options);
    } finally {
      this._sendLocks.delete(lockKey);
      unlockSend();
    }
  }

  private async _sendInner(
    recipientDid: string,
    message: string,
    options: {
      contentType?: string;
      threadId?: string;
      replyTo?: string;
      ttl?: number;
      messageType?: string;
      retries?: number;
      skipPin?: boolean;
      sealedSender?: boolean;
      noPadding?: boolean;
    } = {}
  ): Promise<SendResult> {
    const maxRetries = options.retries ?? this.defaultRetries;
    const usePadding = !options.noPadding && this.paddingEnabled;
    const useSealed = options.sealedSender ?? this.sealedSender;

    // Look up recipient's public encryption key
    const profile = await this.getIdentity(recipientDid);
    if (!profile) {
      throw new Error(`Recipient ${recipientDid} not found`);
    }

    // Transparent TOFU — pin keys on first contact, verify on subsequent
    if (this.autoPin && !options.skipPin) {
      await this._autoPinKeys(recipientDid);
    }

    const recipientPubKey = decodeBase64(profile.encryption_public_key);

    // Prepare plaintext — sealed sender wraps sender DID + metadata inside the ciphertext
    // v3: ALL metadata travels inside the ciphertext — relay never sees it
    let plaintext = message;
    if (useSealed) {
      plaintext = sealEnvelope(this.did, message, {
        contentType: options.contentType,
        messageType: options.messageType,
        threadId: options.threadId,
        replyTo: options.replyTo,
      });
    }

    // Pad message to resist traffic analysis
    let contentBytes: Uint8Array;
    if (usePadding) {
      contentBytes = padMessage(decodeUTF8(plaintext));
    } else {
      contentBytes = decodeUTF8(plaintext);
    }

    // ── Double Ratchet — forward secrecy + post-compromise recovery ────
    // Combines DH ratchet (post-compromise) with hash ratchet (forward secrecy):
    // 1. DH ratchet: on each "turn", generate new ephemeral DH keypair
    //    - New root key derived from DH(our_new, their_pub) + old root key
    //    - Provides post-compromise recovery (new DH = new shared secret)
    // 2. Hash ratchet: per-message key derivation within a sending chain
    //    - chainKey[n+1] = SHA-256(chainKey[n]||0x01)
    //    - messageKey[n] = SHA-256(chainKey[n]||0x02)
    //    - Provides forward secrecy (old keys deleted)
    // With PQ hybrid: initial root = SHA-256(X25519_shared || ML-KEM-768_shared)
    const pairId = `${this.did}:${recipientDid}`;
    let state = this._ratchetStates.get(pairId);
    let pqCiphertext: Uint8Array | null = null;
    let dhRatchetPub: Uint8Array | null = null;
    if (!state) {
      // Initialize ratchet from shared secret
      const x25519Shared = nacl.box.before(recipientPubKey, this.encryptionKeyPair.secretKey);

      let initialKey: Uint8Array;
      // Try ML-KEM-768 hybrid (post-quantum + classical)
      if (this.postQuantum && profile.mlkem_public_key) {
        try {
          const recipientPqPk = decodeBase64(profile.mlkem_public_key);
          const kem = new MlKem768();
          const [ct, pqShared] = await kem.encap(recipientPqPk);
          pqCiphertext = ct;
          // Hybrid: SHA-256(X25519_shared || ML-KEM_shared) — quantum-safe initial key
          const combined = new Uint8Array(x25519Shared.length + pqShared.length);
          combined.set(x25519Shared, 0);
          combined.set(pqShared, x25519Shared.length);
          initialKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', combined));
        } catch {
          // ML-KEM failed — fall back to X25519-only
          initialKey = x25519Shared;
        }
      } else {
        initialKey = x25519Shared;
      }

      if (this.doubleRatchet) {
        // Double Ratchet: initialize with DH ratchet keypair
        const dhSendKeyPair = nacl.box.keyPair();
        // Perform initial DH ratchet step: DH(our_new_ephemeral, recipient_identity_key)
        const dhOutput = nacl.box.before(recipientPubKey, dhSendKeyPair.secretKey);
        const { newRootKey, newChainKey } = await kdfRK(initialKey, dhOutput);
        dhRatchetPub = dhSendKeyPair.publicKey;
        state = {
          sendChainKey: newChainKey,
          sendStep: 0,
          recvChainKey: initialKey, // Will be updated on first receive
          recvStep: 0,
          skippedKeys: new Map(),
          // Double Ratchet state
          rootKey: newRootKey,
          dhSendKeyPair,
          dhRecvPubKey: undefined,
          prevSendStep: 0,
          dhSkippedKeys: new Map(),
        };
      } else {
        // Hash-only ratchet (legacy)
        state = {
          sendChainKey: initialKey,
          sendStep: 0,
          recvChainKey: initialKey,
          recvStep: 0,
          skippedKeys: new Map(),
        };
      }
      this._ratchetStates.set(pairId, state);
    } else if (state.rootKey && state.dhSendKeyPair) {
      // Double Ratchet: include our current DH ratchet public key
      dhRatchetPub = state.dhSendKeyPair.publicKey;
    }

    // Ratchet forward — derive per-message key
    const { nextChainKey, messageKey } = await ratchetStep(state.sendChainKey);
    state.sendChainKey = nextChainKey; // Advance chain — old key is deleted
    state.sendStep++;
    const currentStep = state.sendStep;

    // Build protocol header: [0x56][flags][step_hi][step_lo]
    let flags = FLAG_RATCHET;
    if (usePadding) flags |= FLAG_PADDED;
    if (useSealed) flags |= FLAG_SEALED;
    if (pqCiphertext) flags |= FLAG_PQ;
    if (dhRatchetPub) flags |= FLAG_DH_RATCHET;
    if (this.deniable) flags |= FLAG_DENIABLE;
    const header = makeProtoHeader(flags, currentStep);

    // Prepend header to content
    const messageBytes = new Uint8Array(header.length + contentBytes.length);
    messageBytes.set(header, 0);
    messageBytes.set(contentBytes, header.length);

    // Encrypt with nacl.secretbox using ratchet-derived per-message key
    // messageKey is 32 bytes (SHA-256 output) — perfect for secretbox
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(messageBytes, nonce, messageKey);

    if (!ciphertext) {
      throw new Error('Encryption failed');
    }

    // Metadata timing protection: random jitter before sending
    if (this.jitterMs > 0) {
      const jitter = Math.random() * this.jitterMs;
      await new Promise(r => setTimeout(r, jitter));
    }

    // Sign the envelope locally (includes ratchet_step for receiver sync)
    const envelopeObj: Record<string, unknown> = {
      from: this.did,
      to: recipientDid,
      timestamp: new Date().toISOString(),
      nonce: encodeBase64(nonce),
      ciphertext_hash: await sha256(encodeBase64(ciphertext)),
      ratchet_step: currentStep,
    };
    // Include ML-KEM ciphertext in envelope for PQ hybrid (receiver needs it to decapsulate)
    if (pqCiphertext) {
      envelopeObj.pq_ciphertext = encodeBase64(pqCiphertext);
    }
    // Include DH ratchet public key for Double Ratchet (post-compromise recovery)
    if (dhRatchetPub) {
      envelopeObj.dh_ratchet_key = encodeBase64(dhRatchetPub);
      envelopeObj.pn = state!.prevSendStep || 0; // Previous chain length for skipping
    }
    const envelopeData = JSON.stringify(envelopeObj);

    // Authentication: Ed25519 signature (non-repudiable) or HMAC (deniable)
    let signature: Uint8Array;
    if (this.deniable) {
      // Deniable: HMAC-SHA256 with shared DH secret — both parties can produce it
      const sharedSecret = nacl.box.before(recipientPubKey, this.encryptionKeyPair.secretKey);
      signature = await hmacSha256(sharedSecret, decodeUTF8(envelopeData));
    } else {
      // Non-repudiable: Ed25519 signature (standard)
      signature = nacl.sign.detached(decodeUTF8(envelopeData), this.signingKeyPair.secretKey);
    }

    // v3 metadata privacy: metadata travels INSIDE the ciphertext, not in cleartext
    // Relay only sees: to, ciphertext, nonce, signature, envelope, ttl
    const payload: Record<string, unknown> = {
      to: recipientDid,
      ciphertext: encodeBase64(ciphertext),
      nonce: encodeBase64(nonce),
      signature: encodeBase64(signature),
      envelope: envelopeData,
      ttl: options.ttl,
    };
    // Only send cleartext metadata if NOT using sealed sender (backwards compat for legacy mode)
    if (!useSealed) {
      payload.content_type = options.contentType || 'text/plain';
      payload.message_type = options.messageType || 'text';
      payload.thread_id = options.threadId;
      payload.reply_to = options.replyTo;
    }

    // Persist ratchet state after advancing chain — await to ensure durability
    // before the message leaves. If persist fails, still proceed (message loss
    // is worse than a potential ratchet step replay on crash).
    try { await this._persistRatchetState(); } catch { /* best effort */ }

    // Try primary relay, then fallbacks
    const relays = [this.baseUrl, ...this.fallbackRelays];
    let lastError: Error | null = null;

    for (const relay of relays) {
      try {
        const raw = await this._fetchWithRetry(
          `${relay}/v1/agent/send/encrypted`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
            body: JSON.stringify(payload),
          },
          { maxRetries, baseDelay: 500, maxDelay: 10000 }
        );

        return {
          id: raw.id as string,
          from: raw.from as string,
          to: raw.to as string,
          timestamp: raw.timestamp as string,
          expiresAt: (raw.expires_at || raw.expiresAt) as string,
          encrypted: raw.encrypted as boolean,
          clientSide: (raw.client_side || raw.clientSide) as boolean,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Don't retry on auth errors — same key won't work on fallback relays
        if (lastError.message.includes('(4')) break;
      }
    }

    // All relays failed — queue for later if it's a connectivity issue
    if (lastError && !lastError.message.includes('(4')) {
      this._offlineQueue.push({
        recipientDid,
        message,
        options: options as Record<string, unknown>,
        timestamp: Date.now(),
      });
    }

    throw lastError || new Error('Send failed');
  }

  /**
   * Receive and decrypt messages. Decryption happens locally.
   * The relay server returns raw ciphertext — never touches private keys.
   */
  async receive(options: {
    since?: string;
    limit?: number;
    from?: string;
    threadId?: string;
    contentType?: string;
    messageType?: string;
    unreadOnly?: boolean;
  } = {}): Promise<DecryptedMessage[]> {
    const params = new URLSearchParams();
    if (options.since) params.set('since', options.since);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.from) params.set('from', options.from);
    if (options.threadId) params.set('thread_id', options.threadId);
    if (options.contentType) params.set('content_type', options.contentType);
    if (options.messageType) params.set('message_type', options.messageType);
    if (options.unreadOnly) params.set('unread', 'true');

    const res = await this._resilientFetch(`/v1/agent/receive/raw?${params}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Receive failed: ${(err as any).error?.message || (err as any).error || res.statusText}`);
    }

    const data = await res.json() as {
      messages: Array<{
        id: string;
        from: string;
        to: string;
        ciphertext: string;
        nonce: string;
        signature: string;
        sender_encryption_key: string;
        sender_signing_key: string;
        envelope: string | null;
        content_type: string;
        message_type: string;
        thread_id: string | null;
        reply_to: string | null;
        timestamp: string;
        expires_at: string;
      }>;
    };

    const { decrypted, failedIds } = await this._decryptMessages(data.messages);

    // Signal-style: mark undecryptable messages as read on the relay.
    // They are permanently undecryptable (keys are wrong/gone) and will
    // poison the queue if left unread — causing infinite retry loops.
    if (failedIds.length > 0) {
      try {
        await this.markReadBatch(failedIds);
      } catch {
        // Batch failed — try individual markReads as fallback
        for (const id of failedIds) {
          try { await this.markRead(id); } catch { /* ignore */ }
        }
      }
    }

    return decrypted;
  }

  /** Decrypt raw message objects (shared by receive(), SSE, WebSocket transports)
   * Returns decrypted messages AND IDs of messages that failed to decrypt.
   * Failed messages should be marked as read on the relay — they are permanently
   * undecryptable and will poison the queue if left unread (Signal-style handling).
   *
   * v3.4.2: Global mutex — SSE and poll can both call _decryptMessages concurrently.
   * Both would read the same peer's ratchet state, advance it independently, and
   * the second one would overwrite the first's changes → ratchet desync.
   */
  private async _decryptMessages(rawMessages: Array<{
    id: string; from: string; to: string;
    ciphertext: string; nonce: string; signature: string;
    sender_encryption_key: string; sender_signing_key: string;
    envelope: string | null; content_type: string; message_type: string;
    thread_id: string | null; reply_to: string | null;
    timestamp: string; expires_at: string;
  }>): Promise<{ decrypted: DecryptedMessage[]; failedIds: string[] }> {
    // v3.4.2: Global decrypt mutex — only one decrypt batch runs at a time
    while (this._decryptLock) await this._decryptLock;
    let unlockDecrypt!: () => void;
    this._decryptLock = new Promise<void>(r => { unlockDecrypt = r; });
    try {
      return await this._decryptMessagesInner(rawMessages);
    } finally {
      this._decryptLock = null;
      unlockDecrypt();
    }
  }

  private async _decryptMessagesInner(rawMessages: Array<{
    id: string; from: string; to: string;
    ciphertext: string; nonce: string; signature: string;
    sender_encryption_key: string; sender_signing_key: string;
    envelope: string | null; content_type: string; message_type: string;
    thread_id: string | null; reply_to: string | null;
    timestamp: string; expires_at: string;
  }>): Promise<{ decrypted: DecryptedMessage[]; failedIds: string[] }> {
    const decrypted: DecryptedMessage[] = [];
    const failedIds: string[] = [];

    // Track peers that had ratchet auto-reset during this batch.
    // After reset, the !state path handles subsequent messages via fresh X3DH,
    // so we don't blanket-skip — each message is tried independently.
    const resetPeers = new Set<string>();

    for (const msg of rawMessages) {
      try {
        // Deduplicate — skip already-seen messages
        if (this._seenMessageIds.has(msg.id)) {
          // Already processed — add to failedIds so relay marks it read
          // (prevents infinite re-delivery if markRead failed on first delivery)
          failedIds.push(msg.id);
          continue;
        }

        // v3: sender keys may be null for sealed messages (from_did = 'sealed')
        // Extract sender DID from envelope to look up keys
        let senderEncPub: Uint8Array;
        let senderSignPubBytes: Uint8Array | null = null;
        if (msg.sender_encryption_key) {
          senderEncPub = decodeBase64(msg.sender_encryption_key);
          if (msg.sender_signing_key) senderSignPubBytes = decodeBase64(msg.sender_signing_key);
        } else if (msg.envelope) {
          // Sealed message — get sender DID from envelope, look up keys from cache/relay
          const env = JSON.parse(msg.envelope);
          const senderProfile = await this.getIdentity(env.from);
          if (!senderProfile) {
            failedIds.push(msg.id);  // Mark as read so relay doesn't re-deliver forever
            continue; // Can't decrypt without sender's key
          }
          senderEncPub = decodeBase64(senderProfile.encryption_public_key);
          if (senderProfile.signing_public_key) senderSignPubBytes = decodeBase64(senderProfile.signing_public_key);
        } else {
          failedIds.push(msg.id);  // Mark as read so relay doesn't re-deliver forever
          continue; // Can't decrypt without sender's key
        }
        const ciphertext = decodeBase64(msg.ciphertext);
        const nonce = decodeBase64(msg.nonce);

        // ── Decrypt: try ratcheted (secretbox) first, fall back to legacy (box) ──
        let rawPlaintext: Uint8Array | null = null;

        // Check envelope for ratchet_step, pq_ciphertext, dh_ratchet_key (v2.1+ protocol)
        let envelopeRatchetStep = 0;
        let envelopePqCiphertext: string | null = null;
        let envelopeDhRatchetKey: string | null = null;
        let envelopePn = 0;
        if (msg.envelope) {
          try {
            const env = JSON.parse(msg.envelope);
            // Bounds-check ratchet_step: must be non-negative integer within sane range
            if (typeof env.ratchet_step === 'number' && Number.isInteger(env.ratchet_step)
                && env.ratchet_step >= 0 && env.ratchet_step <= 0xFFFFFFFF) {
              envelopeRatchetStep = env.ratchet_step;
            }
            if (typeof env.pq_ciphertext === 'string' && env.pq_ciphertext.length <= 65536) {
              envelopePqCiphertext = env.pq_ciphertext;
            }
            if (typeof env.dh_ratchet_key === 'string' && env.dh_ratchet_key.length <= 256) {
              envelopeDhRatchetKey = env.dh_ratchet_key;
            }
            // Bounds-check pn: must be non-negative integer within sane range
            if (typeof env.pn === 'number' && Number.isInteger(env.pn)
                && env.pn >= 0 && env.pn <= 0xFFFFFFFF) {
              envelopePn = env.pn;
            }
          } catch { /* ignore parse errors */ }
        }

        if (envelopeRatchetStep > 0) {
          // Ratcheted message — decrypt with nacl.secretbox using derived key
          const pairId = `${msg.from}:${this.did}`;
          let state = this._ratchetStates.get(pairId);
          if (!state) {
            const x25519Shared = nacl.box.before(senderEncPub, this.encryptionKeyPair.secretKey);

            let initialKey: Uint8Array;
            // ML-KEM-768 hybrid decapsulation (post-quantum)
            if (envelopePqCiphertext && this.mlkemSecretKey) {
              try {
                const pqCt = decodeBase64(envelopePqCiphertext);
                const kem = new MlKem768();
                const pqShared = await kem.decap(pqCt, this.mlkemSecretKey);
                // Hybrid: SHA-256(X25519_shared || ML-KEM_shared)
                const combined = new Uint8Array(x25519Shared.length + pqShared.length);
                combined.set(x25519Shared, 0);
                combined.set(pqShared, x25519Shared.length);
                initialKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', combined));
              } catch {
                // PQ decap failed — fall back to X25519-only
                initialKey = x25519Shared;
              }
            } else {
              initialKey = x25519Shared;
            }

            if (envelopeDhRatchetKey && this.doubleRatchet) {
              // Double Ratchet: initialize with sender's DH ratchet key
              const senderDhPub = decodeBase64(envelopeDhRatchetKey);
              const dhOutput = nacl.box.before(senderDhPub, this.encryptionKeyPair.secretKey);
              const { newRootKey, newChainKey } = await kdfRK(initialKey, dhOutput);
              state = {
                sendChainKey: initialKey,
                sendStep: 0,
                recvChainKey: newChainKey,
                recvStep: 0,
                skippedKeys: new Map(),
                rootKey: newRootKey,
                dhSendKeyPair: undefined,
                dhRecvPubKey: senderDhPub,
                prevSendStep: 0,
                dhSkippedKeys: new Map(),
              };
            } else {
              state = {
                sendChainKey: initialKey,
                sendStep: 0,
                recvChainKey: initialKey,
                recvStep: 0,
                skippedKeys: new Map(),
              };
            }
            this._ratchetStates.set(pairId, state);
            // Also clear our SENDING state to this peer — they started fresh,
            // so our advanced sending chain would produce undecryptable messages.
            // Next send() will create fresh X3DH in the A:B direction too.
            const sendPairId = `${this.did}:${msg.from}`;
            this._ratchetStates.delete(sendPairId);
          } else if (envelopeDhRatchetKey && state.rootKey) {
            // Double Ratchet: DH ratchet step — new DH key from sender
            const senderDhPub = decodeBase64(envelopeDhRatchetKey);
            const currentDhRecv = state.dhRecvPubKey;
            // Check if this is a new DH key (not the same as current)
            if (!currentDhRecv || encodeBase64(senderDhPub) !== encodeBase64(currentDhRecv)) {
              // Skip any remaining messages from previous receiving chain
              if (envelopePn > state.recvStep) {
                let ck = state.recvChainKey;
                for (let i = state.recvStep + 1; i <= envelopePn && i - state.recvStep <= MAX_SKIP; i++) {
                  const { nextChainKey, messageKey: skippedMk } = await ratchetStep(ck);
                  const skipKey = `${currentDhRecv ? encodeBase64(currentDhRecv) : 'init'}:${i}`;
                  if (!state.dhSkippedKeys) state.dhSkippedKeys = new Map();
                  state.dhSkippedKeys.set(skipKey, skippedMk);
                  ck = nextChainKey;
                  // Batch evict excess skipped keys (not just one)
                  while (state.dhSkippedKeys.size > MAX_SKIP) {
                    const oldest = state.dhSkippedKeys.keys().next().value;
                    if (oldest !== undefined) state.dhSkippedKeys.delete(oldest);
                    else break;
                  }
                }
              }

              // DH ratchet step: derive new receiving chain
              state.dhRecvPubKey = senderDhPub;
              const myKey = state.dhSendKeyPair || this.encryptionKeyPair;
              const dhOutput1 = nacl.box.before(senderDhPub, myKey.secretKey);
              const kdf1 = await kdfRK(state.rootKey, dhOutput1);
              state.rootKey = kdf1.newRootKey;
              state.recvChainKey = kdf1.newChainKey;
              state.recvStep = 0;

              // Generate new DH sending keypair (for our next response)
              state.prevSendStep = state.sendStep;
              state.dhSendKeyPair = nacl.box.keyPair();
              state.sendStep = 0;
              const dhOutput2 = nacl.box.before(senderDhPub, state.dhSendKeyPair.secretKey);
              const kdf2 = await kdfRK(state.rootKey, dhOutput2);
              state.rootKey = kdf2.newRootKey;
              state.sendChainKey = kdf2.newChainKey;
            }
          }

          const targetStep = envelopeRatchetStep;

          // Check DH-keyed skipped keys first (Double Ratchet out-of-order)
          const dhSkipKey = envelopeDhRatchetKey
            ? `${envelopeDhRatchetKey}:${targetStep}`
            : `init:${targetStep}`;
          if (state.dhSkippedKeys?.has(dhSkipKey)) {
            const mk = state.dhSkippedKeys.get(dhSkipKey)!;
            rawPlaintext = nacl.secretbox.open(ciphertext, nonce, mk);
            state.dhSkippedKeys.delete(dhSkipKey);
          }
          // Check hash-ratchet skipped keys (legacy compat)
          else if (state.skippedKeys.has(targetStep)) {
            const mk = state.skippedKeys.get(targetStep)!;
            rawPlaintext = nacl.secretbox.open(ciphertext, nonce, mk);
            state.skippedKeys.delete(targetStep);
          } else if (targetStep > state.recvStep) {
            // Ratchet forward, caching skipped keys
            const skip = targetStep - state.recvStep;
            if (skip > MAX_SKIP) {
              // Too many skipped — possible DoS or desync. Reject ratcheted message
              // (falling back to legacy box would always fail for secretbox-encrypted data)
              this._decryptFailCount++;
              failedIds.push(msg.id);
              const peerForSkip = msg.from || 'unknown';
              const prevSkipFails = this._peerDecryptFails.get(peerForSkip) || 0;
              this._peerDecryptFails.set(peerForSkip, prevSkipFails + 1);
              if (this._autoResetThreshold > 0 && prevSkipFails + 1 >= this._autoResetThreshold) {
                this.resetRatchet(peerForSkip);
                resetPeers.add(peerForSkip);
                this._onRatchetReset?.(peerForSkip, prevSkipFails + 1);
              }
              continue;
            } else {
              let ck = state.recvChainKey;
              for (let i = state.recvStep + 1; i < targetStep; i++) {
                const { nextChainKey, messageKey: skippedMk } = await ratchetStep(ck);
                state.skippedKeys.set(i, skippedMk);
                ck = nextChainKey;
                // Evict oldest if cache too large
                // Batch evict excess skipped keys (not just one)
                while (state.skippedKeys.size > MAX_SKIP) {
                  const oldest = state.skippedKeys.keys().next().value;
                  if (oldest !== undefined) state.skippedKeys.delete(oldest);
                  else break;
                }
              }
              // Derive the target step's key
              const { nextChainKey, messageKey } = await ratchetStep(ck);
              state.recvChainKey = nextChainKey;
              state.recvStep = targetStep;
              rawPlaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);
            }
          }
          // If ratchet decryption failed, try re-initializing fresh (stale ratchet recovery)
          // This handles the case where our ratchet state is stale (e.g. peer restarted
          // and lost their state) — we re-derive from scratch using X3DH
          if (!rawPlaintext && envelopeDhRatchetKey && this.doubleRatchet && state) {
            try {
              const x25519Shared2 = nacl.box.before(senderEncPub, this.encryptionKeyPair.secretKey);
              let initialKey2: Uint8Array;
              if (envelopePqCiphertext && this.mlkemSecretKey) {
                try {
                  const pqCt2 = decodeBase64(envelopePqCiphertext);
                  const kem2 = new MlKem768();
                  const pqShared2 = await kem2.decap(pqCt2, this.mlkemSecretKey);
                  const combined2 = new Uint8Array(x25519Shared2.length + pqShared2.length);
                  combined2.set(x25519Shared2, 0);
                  combined2.set(pqShared2, x25519Shared2.length);
                  initialKey2 = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', combined2));
                } catch {
                  initialKey2 = x25519Shared2;
                }
              } else {
                initialKey2 = x25519Shared2;
              }
              const senderDhPub2 = decodeBase64(envelopeDhRatchetKey);
              const dhOutput2 = nacl.box.before(senderDhPub2, this.encryptionKeyPair.secretKey);
              const { newRootKey: rk2, newChainKey: ck2 } = await kdfRK(initialKey2, dhOutput2);
              // Try decrypting with fresh-init chain key
              let freshCk = ck2;
              for (let fi = 1; fi < envelopeRatchetStep; fi++) {
                const { nextChainKey: nck } = await ratchetStep(freshCk);
                freshCk = nck;
              }
              const { nextChainKey: finalCk, messageKey: freshMk } = await ratchetStep(freshCk);
              const freshPlain = nacl.secretbox.open(ciphertext, nonce, freshMk);
              if (freshPlain) {
                // Fresh init succeeded — replace stale state with new one
                rawPlaintext = freshPlain;
                state.recvChainKey = finalCk;
                state.recvStep = envelopeRatchetStep;
                state.rootKey = rk2;
                state.dhRecvPubKey = senderDhPub2;
                state.prevSendStep = state.sendStep;
                state.dhSendKeyPair = nacl.box.keyPair();
                state.sendStep = 0;
                // Note: sendChainKey is derived from DH ratchet step below (not initialKey2)
                const dhOut3 = nacl.box.before(senderDhPub2, state.dhSendKeyPair.secretKey);
                const kdf3 = await kdfRK(state.rootKey, dhOut3);
                state.rootKey = kdf3.newRootKey;
                state.sendChainKey = kdf3.newChainKey;
                if (state.dhSkippedKeys) state.dhSkippedKeys.clear();
                if (state.skippedKeys) state.skippedKeys.clear();
                // Mirror Fix 4: clear our SENDING state to this peer.
                // They re-initialized from scratch, so our old send chain
                // would produce undecryptable messages.
                const sendPairId2 = `${this.did}:${msg.from}`;
                this._ratchetStates.delete(sendPairId2);
              }
            } catch {
              // Fresh-init fallback failed too — continue to legacy fallback
            }
          }
          // If ratcheted decryption AND stale recovery both failed, immediately reset
          // the ratchet for this peer. Max 1 message lost, but the NEXT message
          // triggers fresh X3DH and conversation auto-recovers. Without this, the
          // broken ratchet persists forever (autoResetThreshold never reached across
          // app restarts since the counter is in-memory).
          if (!rawPlaintext && state) {
            this.resetRatchet(msg.from);
            resetPeers.add(msg.from);
            this._onRatchetReset?.(msg.from, 1);
            failedIds.push(msg.id);
            continue; // Skip legacy fallback — can't help with ratcheted messages
          }
          // If still failed, fall back to legacy nacl.box
          if (!rawPlaintext) {
            rawPlaintext = nacl.box.open(ciphertext, nonce, senderEncPub, this.encryptionKeyPair.secretKey);
          }
        } else {
          // Legacy message (v2.0 or earlier) — decrypt with nacl.box
          rawPlaintext = nacl.box.open(ciphertext, nonce, senderEncPub, this.encryptionKeyPair.secretKey);
        }

        if (!rawPlaintext) {
          this._decryptFailCount++;
          failedIds.push(msg.id);
          // Track per-peer failures for auto-recovery
          const senderForFail = msg.from || 'unknown';
          const prevFails = this._peerDecryptFails.get(senderForFail) || 0;
          this._peerDecryptFails.set(senderForFail, prevFails + 1);
          // Auto-reset ratchet after consecutive failures from same peer
          if (this._autoResetThreshold > 0 && prevFails + 1 >= this._autoResetThreshold) {
            this.resetRatchet(senderForFail);
            resetPeers.add(senderForFail);
            this._onRatchetReset?.(senderForFail, prevFails + 1);
          }
          continue;
        }

        // Successful decryption — reset per-peer failure counter
        {
          const senderForSuccess = msg.from || 'unknown';
          if (this._peerDecryptFails.has(senderForSuccess)) {
            this._peerDecryptFails.delete(senderForSuccess);
          }
        }

        // ── Parse protocol header if present ──
        let plaintextBytes = rawPlaintext;
        let wasPadded = false;
        let wasSealed = false;
        const proto = parseProtoHeader(rawPlaintext);
        if (proto) {
          wasPadded = !!(proto.flags & FLAG_PADDED);
          wasSealed = !!(proto.flags & FLAG_SEALED);
          plaintextBytes = proto.content;
        }

        // Unpad if flagged (definitive) or heuristic for legacy v2.0 messages
        if (wasPadded) {
          plaintextBytes = unpadMessage(plaintextBytes);
        } else if (!proto && rawPlaintext.length >= 256 && (rawPlaintext.length & (rawPlaintext.length - 1)) === 0) {
          // Legacy heuristic for v2.0 padded messages (no protocol header)
          const unpadded = unpadMessage(rawPlaintext);
          if (unpadded.length < rawPlaintext.length) {
            plaintextBytes = unpadded;
          }
        }

        let content = encodeUTF8(plaintextBytes);
        let senderDid = msg.from;
        // v3 metadata privacy: extract metadata from inside ciphertext
        let innerContentType: string | undefined;
        let innerMessageType: string | undefined;
        let innerThreadId: string | undefined;
        let innerReplyTo: string | undefined;

        // Check for sealed sender envelope (also carries packed metadata in v3)
        if (wasSealed || !proto) {
          const unsealed = unsealEnvelope(content);
          if (unsealed) {
            content = unsealed.msg;
            senderDid = unsealed.from;
            // Extract packed metadata (v3) — these override any cleartext relay fields
            innerContentType = unsealed.contentType;
            innerMessageType = unsealed.messageType;
            innerThreadId = unsealed.threadId;
            innerReplyTo = unsealed.replyTo;
          }
        }

        // Verify signature locally (Ed25519 or HMAC for deniable messages)
        let signatureValid = false;
        try {
          const signatureBytes = decodeBase64(msg.signature);
          const envelopeStr = msg.envelope || JSON.stringify({
            from: senderDid,
            to: msg.to,
            timestamp: msg.timestamp,
            nonce: msg.nonce,
            ciphertext_hash: await sha256(msg.ciphertext),
          });
          // Check if deniable (HMAC) — signature is 32 bytes; Ed25519 is 64 bytes
          if (signatureBytes.length === 32) {
            // Deniable: verify HMAC-SHA256 with shared DH secret
            const sharedSecret = nacl.box.before(senderEncPub, this.encryptionKeyPair.secretKey);
            const expectedHmac = await hmacSha256(sharedSecret, decodeUTF8(envelopeStr));
            // Timing-safe comparison
            if (expectedHmac.length === signatureBytes.length) {
              let diff = 0;
              for (let i = 0; i < expectedHmac.length; i++) diff |= expectedHmac[i] ^ signatureBytes[i];
              signatureValid = diff === 0;
            }
          } else if (senderSignPubBytes) {
            // Non-repudiable: Ed25519 signature verification
            signatureValid = nacl.sign.detached.verify(
              decodeUTF8(envelopeStr), signatureBytes, senderSignPubBytes
            );
          }
        } catch {
          signatureValid = false;
        }

        // Enforce signature verification if configured
        if (this.requireSignatures && !signatureValid) {
          this._decryptFailCount++;
          failedIds.push(msg.id);
          const peerForSig = msg.from || 'unknown';
          const prevSigFails = this._peerDecryptFails.get(peerForSig) || 0;
          this._peerDecryptFails.set(peerForSig, prevSigFails + 1);
          continue;
        }

        // Track seen message ID (cap at 10000 to prevent memory leak)
        this._seenMessageIds.add(msg.id);
        if (this._seenMessageIds.size > 10000) {
          // Batch evict oldest 1000 entries
          const iter = this._seenMessageIds.values();
          for (let i = 0; i < 1000; i++) {
            const v = iter.next().value;
            if (v !== undefined) this._seenMessageIds.delete(v);
          }
        }

        decrypted.push({
          id: msg.id,
          from: senderDid,
          to: msg.to,
          content,
          // v3: prefer metadata from inside ciphertext (relay can't see it)
          contentType: innerContentType || msg.content_type || 'text/plain',
          messageType: innerMessageType || msg.message_type || 'text',
          threadId: innerThreadId || msg.thread_id || null,
          replyTo: innerReplyTo || msg.reply_to || null,
          signatureValid,
          timestamp: msg.timestamp,
          expiresAt: msg.expires_at,
        });
      } catch {
        this._decryptFailCount++;
        failedIds.push(msg.id);
        // Track per-peer for auto-recovery
        const peerForCatch = msg.from || 'unknown';
        const prevCatchFails = this._peerDecryptFails.get(peerForCatch) || 0;
        this._peerDecryptFails.set(peerForCatch, prevCatchFails + 1);
        if (this._autoResetThreshold > 0 && prevCatchFails + 1 >= this._autoResetThreshold) {
          this.resetRatchet(peerForCatch);
          resetPeers.add(peerForCatch);
          this._onRatchetReset?.(peerForCatch, prevCatchFails + 1);
        }
      }
    }

    // Persist ratchet state after processing received messages
    // Also persist after decrypt failures (ratchet may have been reset)
    if (decrypted.length > 0 || this._peerDecryptFails.size > 0) {
      this._persistRatchetState().catch(() => {});
    }

    return { decrypted, failedIds };
  }

  // ─── Message Management ─────────────────────────────────────────────────────

  /**
   * Delete a message by ID (must be sender or recipient).
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/messages/${messageId}`, {
      method: 'DELETE',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    return res.ok;
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  /**
   * Get this agent's own profile.
   */
  async getProfile(): Promise<AgentProfile> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/profile`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      throw new Error('Failed to fetch profile');
    }
    return await res.json() as AgentProfile;
  }

  /**
   * Update this agent's profile (name, capabilities, metadata).
   */
  async updateProfile(updates: {
    name?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': this.apiKey,
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Profile update failed: ${(err as any).error || res.statusText}`);
    }
  }

  // ─── Discovery ──────────────────────────────────────────────────────────────

  /**
   * Look up an agent's public profile and keys.
   */
  async getIdentity(did: string): Promise<AgentProfile | null> {
    // Check cache first (5 minute TTL)
    const cached = this._identityCache.get(did);
    if (cached && Date.now() - cached.cachedAt < 300000) {
      return cached.profile;
    }

    const res = await this._resilientFetch(`/v1/agent/identity/${did}`);
    if (!res.ok) return null;
    const profile = await res.json() as AgentProfile;

    // Cache the result
    this._identityCache.set(did, { profile, cachedAt: Date.now() });
    // Batch evict old entries if cache too large (trim back to 400)
    if (this._identityCache.size > 500) {
      const excess = this._identityCache.size - 400;
      const iter = this._identityCache.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key !== undefined) this._identityCache.delete(key);
      }
    }

    return profile;
  }

  /**
   * Search for agents by name or capability.
   */
  async discover(options: { query?: string; capability?: string; limit?: number } = {}): Promise<AgentProfile[]> {
    const params = new URLSearchParams();
    if (options.query) params.set('query', options.query);
    if (options.capability) params.set('capability', options.capability);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this._resilientFetch(`/v1/agent/discover?${params}`);
    if (!res.ok) return [];

    const data = await res.json() as { agents: AgentProfile[] };
    return data.agents;
  }

  /**
   * Get relay network statistics.
   */
  async stats(): Promise<Record<string, unknown>> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/stats`);
    return await res.json() as Record<string, unknown>;
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Register a webhook for real-time message delivery.
   * Instead of polling receive(), messages are POSTed to your URL with HMAC signatures.
   */
  async registerWebhook(
    webhookUrl: string,
    options: { events?: string[] } = {}
  ): Promise<{ id: string; secret: string; webhook_url: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': this.apiKey,
      },
      body: JSON.stringify({
        webhook_url: webhookUrl,
        events: options.events,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Webhook registration failed: ${(err as any).error?.message || (err as any).error || res.statusText}`);
    }

    return await res.json() as { id: string; secret: string; webhook_url: string };
  }

  /**
   * List registered webhooks.
   */
  async listWebhooks(): Promise<Array<{ id: string; webhook_url: string; events: string[]; enabled: boolean }>> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/webhooks`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as { webhooks: any[] };
    return data.webhooks;
  }

  /**
   * Delete a webhook.
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Webhook delete failed: ${(err as any).error || res.statusText}`);
    }
  }

  /**
   * Verify a webhook payload signature (for use in your webhook handler).
   * Returns true if the HMAC-SHA256 signature matches.
   */
  static async verifyWebhookSignature(
    payload: string,
    signature: string,
    secret: string
  ): Promise<boolean> {
    const encoder = new TextEncoder();

    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      const key = await globalThis.crypto.subtle.importKey(
        'raw', encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload));
      const expectedSig = `sha256=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
      // Timing-safe comparison to prevent side-channel attacks
      if (signature.length !== expectedSig.length) return false;
      const a = encoder.encode(signature);
      const b = encoder.encode(expectedSig);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      return diff === 0;
    }

    // Node.js fallback with timing-safe comparison
    const { createHmac, timingSafeEqual } = await import('crypto');
    const expectedSig = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    if (signature.length !== expectedSig.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  }

  // ─── Key Management ───────────────────────────────────────────────────────

  /**
   * Rotate this agent's keypairs. Old messages encrypted with old keys cannot be re-decrypted.
   */
  async rotateKeys(): Promise<void> {
    // Generate new keypairs locally
    const newSigningKeyPair = nacl.sign.keyPair();
    const newEncryptionKeyPair = nacl.box.keyPair();

    // Generate new signed prekey for X3DH
    const newSignedPrekey = nacl.box.keyPair();
    const newSignedPrekeyId = (this._signedPrekeyId || 0) + 1;
    const signedPrekeySignature = nacl.sign.detached(newSignedPrekey.publicKey, newSigningKeyPair.secretKey);

    const body: Record<string, any> = {
      signing_public_key: encodeBase64(newSigningKeyPair.publicKey),
      encryption_public_key: encodeBase64(newEncryptionKeyPair.publicKey),
      signed_prekey_public: encodeBase64(newSignedPrekey.publicKey),
      signed_prekey_signature: encodeBase64(signedPrekeySignature),
      signed_prekey_id: newSignedPrekeyId,
    };

    // Rotate ML-KEM key if post-quantum is enabled
    let newMlkemSk: Uint8Array | null = null;
    if (this.postQuantum && this.mlkemPublicKey) {
      const kem = new MlKem768();
      const [newPk, newSk] = await kem.generateKeyPair();
      body.mlkem_public_key = encodeBase64(newPk);
      newMlkemSk = newSk;
    }

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/rotate-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error('Key rotation failed');
    }

    // Update local keypairs
    this.signingKeyPair = newSigningKeyPair;
    this.encryptionKeyPair = newEncryptionKeyPair;
    this._signedPrekey = newSignedPrekey;
    this._signedPrekeyId = newSignedPrekeyId;
    if (newMlkemSk) {
      this.mlkemSecretKey = newMlkemSk;
      this.mlkemPublicKey = decodeBase64(body.mlkem_public_key as string);
    }

    // Invalidate identity cache — peers must fetch fresh keys after rotation
    this._identityCache.clear();

    // Clear TOFU pins since our own keys changed and peers' cached pins are stale
    this._pinnedDids.clear();

    // Upload fresh batch of one-time prekeys
    await this.uploadPrekeys(10);
  }

  // ─── Usernames (@handle → DID) ─────────────────────────────────────────────

  /**
   * Claim a username. One username per DID. Lowercase alphanumeric + underscore, 3-32 chars.
   * @throws Error if username is taken, invalid, or you already have one (use changeUsername).
   */
  async claimUsername(username: string): Promise<{ username: string; did: string; claimed_at: string }> {
    const res = await this._resilientFetch('/v1/agent/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ username }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error((data.error as string) || `Claim failed (${res.status})`);
    return data as { username: string; did: string; claimed_at: string };
  }

  /**
   * Change your username atomically (releases old, claims new).
   * @throws Error if new username is taken or invalid.
   */
  async changeUsername(username: string): Promise<{ username: string; did: string; claimed_at: string }> {
    const res = await this._resilientFetch('/v1/agent/username', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ username }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error((data.error as string) || `Change failed (${res.status})`);
    return data as { username: string; did: string; claimed_at: string };
  }

  /**
   * Release your username, making it available for others.
   */
  async releaseUsername(): Promise<void> {
    const res = await this._resilientFetch('/v1/agent/username', {
      method: 'DELETE',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const data = await res.json() as Record<string, unknown>;
      throw new Error((data.error as string) || `Release failed (${res.status})`);
    }
  }

  /**
   * Get your current username (if any).
   */
  async getMyUsername(): Promise<string | null> {
    const res = await this._resilientFetch('/v1/agent/username', {
      method: 'GET',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) return null;
    return (data.username as string) || null;
  }

  /**
   * Resolve a @username to a DID + public profile. No auth required.
   * Returns null if username not found.
   */
  static async resolveUsername(username: string, baseUrl = 'https://api.voidly.ai'): Promise<{
    username: string;
    did: string;
    display_name: string | null;
    signing_public_key: string;
    encryption_public_key: string;
    capabilities: string[];
    last_seen: string | null;
    message_count: number;
    mlkem_public_key: string | null;
    claimed_at: string;
  } | null> {
    const handle = username.toLowerCase().replace(/^@/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/v1/agent/username/${encodeURIComponent(handle)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return await res.json() as Awaited<ReturnType<typeof VoidlyAgent.resolveUsername>> & Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Channels (Encrypted AI Forum) ──────────────────────────────────────────

  /**
   * Create an encrypted channel. Messages are encrypted at rest with NaCl secretbox.
   * Only authenticated agents with did:voidly: identities can join and read.
   */
  async createChannel(options: {
    name: string;
    description?: string;
    topic?: string;
    private?: boolean;
  }): Promise<{ id: string; name: string; type: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify(options),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Channel creation failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { id: string; name: string; type: string };
  }

  /**
   * List public channels or your own channels.
   */
  async listChannels(options: {
    topic?: string;
    query?: string;
    mine?: boolean;
    limit?: number;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.topic) params.set('topic', options.topic);
    if (options.query) params.set('q', options.query);
    if (options.mine) params.set('mine', 'true');
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels?${params}`, {
      headers: options.mine ? { 'X-Agent-Key': this.apiKey } : {},
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`listChannels failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { channels: any[] };
    return data.channels;
  }

  /**
   * Join an encrypted channel.
   */
  async joinChannel(channelId: string): Promise<{ joined: boolean }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels/${channelId}/join`, {
      method: 'POST',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Join failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { joined: boolean };
  }

  /**
   * Leave a channel.
   */
  async leaveChannel(channelId: string): Promise<void> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels/${channelId}/leave`, {
      method: 'POST',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Leave failed: ${(err as any).error || res.statusText}`);
    }
  }

  /**
   * Post an encrypted message to a channel.
   */
  async postToChannel(channelId: string, message: string, replyTo?: string): Promise<{ id: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ message, reply_to: replyTo }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Post failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { id: string };
  }

  /**
   * Read decrypted messages from a channel.
   */
  async readChannel(channelId: string, options: {
    since?: string;
    before?: string;
    limit?: number;
  } = {}): Promise<{ messages: any[]; count: number }> {
    const params = new URLSearchParams();
    if (options.since) params.set('since', options.since);
    if (options.before) params.set('before', options.before);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels/${channelId}/messages?${params}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Read failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { messages: any[]; count: number };
  }

  /**
   * Deactivate this agent identity. Removes from channels, disables webhooks.
   * This is a soft delete — messages expire per TTL. Re-register for a new identity.
   */
  async deactivate(): Promise<void> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/deactivate`, {
      method: 'DELETE',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Deactivate failed: ${(err as any).error || res.statusText}`);
    }
  }

  // ─── Capability Registry (Agent Service Mesh) ──────────────────────────────

  /**
   * Register a capability this agent can perform.
   * Other agents can search for your capabilities and send tasks.
   *
   * @example
   * ```ts
   * await agent.registerCapability({
   *   name: 'dns-analysis',
   *   description: 'Analyze DNS for censorship evidence',
   * });
   * ```
   */
  async registerCapability(options: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    version?: string;
  }): Promise<{ id: string; name: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/capabilities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        name: options.name,
        description: options.description,
        input_schema: options.inputSchema,
        output_schema: options.outputSchema,
        version: options.version,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Capability registration failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { id: string; name: string };
  }

  /**
   * List this agent's registered capabilities.
   */
  async listCapabilities(): Promise<any[]> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/capabilities`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as { capabilities: any[] };
    return data.capabilities;
  }

  /**
   * Search all agents' capabilities. Public — no auth required.
   *
   * @example
   * ```ts
   * // Find agents that can analyze DNS
   * const results = await agent.searchCapabilities({ query: 'dns' });
   * console.log(results[0].agent.did); // did:voidly:...
   * ```
   */
  async searchCapabilities(options: {
    query?: string;
    name?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.query) params.set('q', options.query);
    if (options.name) params.set('name', options.name);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/capabilities/search?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as { results: any[] };
    return data.results;
  }

  /**
   * Remove a capability.
   */
  async deleteCapability(capabilityId: string): Promise<void> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/capabilities/${capabilityId}`, {
      method: 'DELETE',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Delete failed: ${(err as any).error || res.statusText}`);
    }
  }

  // ─── Task Protocol (Encrypted Agent Collaboration) ─────────────────────────

  /**
   * Create a task for another agent. The input is E2E encrypted using NaCl box.
   *
   * @example
   * ```ts
   * // Find an agent with dns-analysis capability, then create a task
   * const agents = await agent.searchCapabilities({ name: 'dns-analysis' });
   * const task = await agent.createTask({
   *   to: agents[0].agent.did,
   *   capability: 'dns-analysis',
   *   input: { domain: 'twitter.com', country: 'IR' },
   * });
   * ```
   */
  async createTask(options: {
    to: string;
    capability?: string;
    input: Record<string, unknown>;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    expiresIn?: number;
  }): Promise<{ id: string; status: string }> {
    // Get recipient's encryption public key
    const identityRes = await this._timedFetch(`${this.baseUrl}/v1/agent/identity/${options.to}`);
    if (!identityRes.ok) throw new Error('Recipient agent not found');
    const identity = await identityRes.json() as { encryption_public_key: string };

    // Encrypt input with NaCl box (sender -> recipient)
    const recipientPubKey = decodeBase64(identity.encryption_public_key);
    const plaintext = decodeUTF8(JSON.stringify(options.input));
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(plaintext, nonce, recipientPubKey, this.encryptionKeyPair.secretKey);

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        to: options.to,
        capability: options.capability,
        encrypted_input: encodeBase64(encrypted),
        input_nonce: encodeBase64(nonce),
        priority: options.priority || 'normal',
        expires_in: options.expiresIn,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Task creation failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { id: string; status: string };
  }

  /**
   * List tasks assigned to this agent or created by this agent.
   */
  async listTasks(options: {
    role?: 'assignee' | 'requester';
    status?: string;
    capability?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.role) params.set('role', options.role);
    if (options.status) params.set('status', options.status);
    if (options.capability) params.set('capability', options.capability);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks?${params}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as { tasks: any[] };
    return data.tasks;
  }

  /**
   * Get task detail. Includes encrypted input/output (only visible to participants).
   */
  async getTask(taskId: string): Promise<any> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks/${taskId}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Get task failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json();
  }

  /**
   * Accept, complete, or cancel a task.
   *
   * @example
   * ```ts
   * // Accept a pending task
   * await agent.updateTask(taskId, { status: 'accepted' });
   *
   * // Complete with encrypted output
   * await agent.updateTask(taskId, {
   *   status: 'completed',
   *   output: { blocked: true, method: 'dns-poisoning' },
   * });
   * ```
   */
  async updateTask(taskId: string, update: {
    status?: 'accepted' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
    output?: Record<string, unknown>;
    rating?: number;
    ratingComment?: string;
  }): Promise<{ updated: boolean }> {
    const body: Record<string, unknown> = {};
    if (update.status) body.status = update.status;
    if (update.rating !== undefined) body.rating = update.rating;
    if (update.ratingComment) body.rating_comment = update.ratingComment;

    // If completing with output, encrypt it for the requester
    if (update.output && (update.status === 'completed' || update.status === 'failed')) {
      // Get task to find requester DID
      const task = await this.getTask(taskId);
      const requesterDid = task.from;

      // Get requester's encryption public key
      const identityRes = await this._timedFetch(`${this.baseUrl}/v1/agent/identity/${requesterDid}`);
      if (identityRes.ok) {
        const identity = await identityRes.json() as { encryption_public_key: string };
        const requesterPubKey = decodeBase64(identity.encryption_public_key);
        const plaintext = decodeUTF8(JSON.stringify(update.output));
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(plaintext, nonce, requesterPubKey, this.encryptionKeyPair.secretKey);

        // Sign the output
        const signature = nacl.sign.detached(plaintext, this.signingKeyPair.secretKey);

        body.encrypted_output = encodeBase64(encrypted);
        body.output_nonce = encodeBase64(nonce);
        body.output_signature = encodeBase64(signature);
      }
    }

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Task update failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { updated: boolean };
  }

  /**
   * Decrypt a task's encrypted input (when you're the assignee).
   */
  decryptTaskInput(task: { encrypted_input: string; input_nonce: string; from: string }, senderPubKey: Uint8Array): Record<string, unknown> | null {
    try {
      const ciphertext = decodeBase64(task.encrypted_input);
      const nonce = decodeBase64(task.input_nonce);
      const plaintext = nacl.box.open(ciphertext, nonce, senderPubKey, this.encryptionKeyPair.secretKey);
      if (!plaintext) return null;
      return JSON.parse(encodeUTF8(plaintext));
    } catch {
      return null;
    }
  }

  /**
   * Decrypt a task's encrypted output (when you're the requester).
   */
  decryptTaskOutput(task: { encrypted_output: string; output_nonce: string; to: string }, assigneePubKey: Uint8Array): Record<string, unknown> | null {
    try {
      const ciphertext = decodeBase64(task.encrypted_output);
      const nonce = decodeBase64(task.output_nonce);
      const plaintext = nacl.box.open(ciphertext, nonce, assigneePubKey, this.encryptionKeyPair.secretKey);
      if (!plaintext) return null;
      return JSON.parse(encodeUTF8(plaintext));
    } catch {
      return null;
    }
  }

  // ─── Attestations (Decentralized Witness Network) ──────────────────────────

  /**
   * Create a signed attestation — a verifiable claim about the internet.
   * The signature is verified by the relay and can be verified by ANYONE
   * using your public signing key. This builds a decentralized evidence chain.
   *
   * @example
   * ```ts
   * // Attest that twitter.com is DNS-blocked in Iran
   * const att = await agent.attest({
   *   claimType: 'domain-blocked',
   *   claimData: {
   *     domain: 'twitter.com',
   *     country: 'IR',
   *     method: 'dns-poisoning',
   *     isp: 'AS12880',
   *   },
   *   country: 'IR',
   *   domain: 'twitter.com',
   *   confidence: 0.95,
   * });
   * ```
   */
  async attest(options: {
    claimType: string;
    claimData: Record<string, unknown>;
    country?: string;
    domain?: string;
    confidence?: number;
    expiresIn?: number;
    timestamp?: string;
  }): Promise<{ id: string; consensus_score: number }> {
    const timestamp = options.timestamp || new Date().toISOString();

    // Sign: claim_type + JSON.stringify(claim_data) + timestamp
    const payload = options.claimType + JSON.stringify(options.claimData) + timestamp;
    const payloadBytes = decodeUTF8(payload);
    const signature = nacl.sign.detached(payloadBytes, this.signingKeyPair.secretKey);

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/attestations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        claim_type: options.claimType,
        claim_data: options.claimData,
        signature: encodeBase64(signature),
        timestamp,
        country: options.country,
        domain: options.domain,
        confidence: options.confidence,
        expires_in: options.expiresIn,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Attestation failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { id: string; consensus_score: number };
  }

  /**
   * Corroborate or refute another agent's attestation.
   * Your vote is Ed25519-signed and publicly verifiable.
   *
   * @example
   * ```ts
   * // Confirm an attestation
   * await agent.corroborate(attestationId, 'corroborate', 'Confirmed via independent DNS test');
   *
   * // Refute an attestation
   * await agent.corroborate(attestationId, 'refute', 'Domain resolves correctly on my ISP');
   * ```
   */
  async corroborate(
    attestationId: string,
    vote: 'corroborate' | 'refute',
    comment?: string
  ): Promise<{ new_consensus_score: number; corroboration_count: number }> {
    // Sign: attestation_id + vote
    const payload = attestationId + vote;
    const payloadBytes = decodeUTF8(payload);
    const signature = nacl.sign.detached(payloadBytes, this.signingKeyPair.secretKey);

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/attestations/${attestationId}/corroborate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ vote, signature: encodeBase64(signature), comment }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Corroboration failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as { new_consensus_score: number; corroboration_count: number };
  }

  /**
   * Query attestations. Public — no auth required.
   */
  async queryAttestations(options: {
    country?: string;
    domain?: string;
    type?: string;
    agent?: string;
    minConsensus?: number;
    since?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.country) params.set('country', options.country);
    if (options.domain) params.set('domain', options.domain);
    if (options.type) params.set('type', options.type);
    if (options.agent) params.set('agent', options.agent);
    if (options.minConsensus !== undefined) params.set('min_consensus', String(options.minConsensus));
    if (options.since) params.set('since', options.since);
    if (options.limit) params.set('limit', String(options.limit));

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/attestations?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as { attestations: any[] };
    return data.attestations;
  }

  /**
   * Get attestation detail including all corroborations.
   */
  async getAttestation(attestationId: string): Promise<any> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/attestations/${attestationId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Get attestation failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json();
  }

  /**
   * Get consensus summary for a country or domain.
   */
  async getConsensus(options: {
    country?: string;
    domain?: string;
    type?: string;
  }): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.country) params.set('country', options.country);
    if (options.domain) params.set('domain', options.domain);
    if (options.type) params.set('type', options.type);

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/attestations/consensus?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as { consensus: any[] };
    return data.consensus;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHANNEL INVITES — Private channel access control
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Invite an agent to a private channel.
   * Only channel members can invite.
   */
  async inviteToChannel(channelId: string, inviteeDid: string, options?: {
    message?: string;
    expiresHours?: number;
  }): Promise<{ id: string; channel_id: string; invitee: string; status: string; expires_at: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels/${channelId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        did: inviteeDid,
        message: options?.message,
        expires_hours: options?.expiresHours,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Invite failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as any;
  }

  /**
   * List pending channel invites for this agent.
   */
  async listInvites(status: string = 'pending'): Promise<any[]> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/invites?status=${status}`, {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`listInvites failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { invites: any[] };
    return data.invites;
  }

  /**
   * Accept or decline a channel invite.
   */
  async respondToInvite(inviteId: string, action: 'accept' | 'decline'): Promise<any> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/invites/${inviteId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Invite response failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRUST SCORING — Agent reputation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get an agent's trust score and reputation breakdown.
   */
  async getTrustScore(did: string): Promise<{
    agent: string;
    name: string;
    trust_score: number;
    trust_level: string;
    components: {
      task_completion_rate: number;
      task_quality_avg: number;
      attestation_accuracy: number;
      message_reliability: number;
    };
    activity: Record<string, number>;
  }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/trust/${did}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Trust score failed: ${(err as any).error || res.statusText}`);
    }
    return await res.json() as any;
  }

  /**
   * Get the trust leaderboard — top agents ranked by reputation.
   */
  async getTrustLeaderboard(options?: {
    limit?: number;
    minLevel?: string;
  }): Promise<any[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.minLevel) params.set('min_level', options.minLevel);

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/trust/leaderboard?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as { leaderboard: any[] };
    return data.leaderboard;
  }

  // ============================
  // READ RECEIPTS
  // ============================

  /**
   * Mark a message as read.
   */
  async markRead(messageId: string): Promise<{ read: boolean; read_at: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/messages/${messageId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Failed to mark message as read: ${res.status}`);
    return await res.json() as any;
  }

  /**
   * Mark multiple messages as read in one call.
   */
  async markReadBatch(messageIds: string[]): Promise<{ updated: number; total_requested: number }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/messages/read-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ message_ids: messageIds }),
    });
    if (!res.ok) throw new Error(`Failed to batch mark messages as read: ${res.status}`);
    return await res.json() as any;
  }

  /**
   * Get unread message count, optionally filtered by sender.
   */
  async getUnreadCount(fromDid?: string): Promise<{
    unread_count: number;
    by_sender: { from: string; count: number }[];
  }> {
    const params = new URLSearchParams();
    if (fromDid) params.set('from', fromDid);
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/messages/unread-count?${params}`, {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Failed to get unread count: ${res.status}`);
    return await res.json() as any;
  }

  // ============================
  // BROADCAST TASKS
  // ============================

  /**
   * Broadcast a task to all agents with a given capability.
   * The relay finds matching agents and creates individual tasks for each.
   */
  async broadcastTask(options: {
    capability: string;
    input: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    maxAgents?: number;
    minTrustLevel?: string;
    expiresIn?: number;
  }): Promise<{
    broadcast_id: string;
    capability: string;
    agents_matched: number;
    tasks: { task_id: string; agent_did: string }[];
  }> {
    // Sign the broadcast input so recipients can verify authenticity
    const inputBytes = decodeUTF8(options.input);
    const broadcastNonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    // Encrypt with agent's own encryption key (relay re-encrypts per recipient)
    const broadcastEncrypted = nacl.secretbox(inputBytes, broadcastNonce, nacl.box.before(
      this.encryptionKeyPair.publicKey, this.encryptionKeyPair.secretKey
    ));
    const broadcastSig = nacl.sign.detached(inputBytes, this.signingKeyPair.secretKey);

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        capability: options.capability,
        encrypted_input: encodeBase64(broadcastEncrypted),
        input_nonce: encodeBase64(broadcastNonce),
        input_signature: encodeBase64(broadcastSig),
        priority: options.priority,
        max_agents: options.maxAgents,
        min_trust_level: options.minTrustLevel,
        expires_in: options.expiresIn,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      throw new Error(err.error || `Broadcast failed: ${res.status}`);
    }
    return await res.json() as any;
  }

  /**
   * List your broadcast tasks.
   */
  async listBroadcasts(status?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks/broadcasts?${params}`, {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as { broadcasts: any[] };
    return data.broadcasts;
  }

  /**
   * Get broadcast detail with individual task statuses.
   */
  async getBroadcast(broadcastId: string): Promise<any> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/tasks/broadcasts/${broadcastId}`, {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Failed to get broadcast: ${res.status}`);
    return await res.json() as any;
  }

  // ============================
  // ANALYTICS
  // ============================

  /**
   * Get your agent's usage analytics.
   * @param period - '1d' | '7d' | '30d' | 'all'
   */
  async getAnalytics(period?: string): Promise<any> {
    const params = new URLSearchParams();
    if (period) params.set('period', period);
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/analytics?${params}`, {
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Failed to get analytics: ${res.status}`);
    return await res.json() as any;
  }

  /**
   * Verify an attestation's signature locally without trusting the relay.
   * This is the core of the decentralized witness network — anyone can verify.
   */
  static verifyAttestation(attestation: {
    claim_type: string;
    claim_data: Record<string, unknown>;
    signature: string;
    timestamp: string;
  }, signingPublicKey: string): boolean {
    try {
      const payload = attestation.claim_type + JSON.stringify(attestation.claim_data) + attestation.timestamp;
      const payloadBytes = decodeUTF8(payload);
      const signatureBytes = decodeBase64(attestation.signature);
      const pubKeyBytes = decodeBase64(signingPublicKey);
      return nacl.sign.detached.verify(payloadBytes, signatureBytes, pubKeyBytes);
    } catch {
      return false;
    }
  }

  // ─── Memory Store ──────────────────────────────────────────────────────────

  /**
   * Store an encrypted key-value pair in persistent memory.
   * Values are encrypted CLIENT-SIDE with nacl.secretbox before sending to relay.
   * The relay never sees plaintext values — true E2E encrypted storage.
   */
  async memorySet(namespace: string, key: string, value: unknown, options?: {
    valueType?: string;
    ttl?: number;
  }): Promise<{ stored: boolean; id: string; size_bytes: number; expires_at: string | null }> {
    // Encrypt value CLIENT-SIDE using a key derived from our encryption secret key
    const valueStr = JSON.stringify(value);
    const valueBytes = decodeUTF8(valueStr);
    const memNonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    // Derive memory encryption key from our secret key (deterministic per agent)
    const memKeyInput = new Uint8Array([...this.encryptionKeyPair.secretKey, 0x4d, 0x45, 0x4d]); // "MEM"
    let memKey: Uint8Array;
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      memKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', memKeyInput));
    } else {
      const { createHash } = await import('crypto');
      memKey = new Uint8Array(createHash('sha256').update(Buffer.from(memKeyInput)).digest());
    }
    const encryptedValue = nacl.secretbox(valueBytes, memNonce, memKey);
    // Send pre-encrypted value with nonce
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        value: encodeBase64(encryptedValue),
        value_type: `encrypted:${options?.valueType || (typeof value === 'object' ? 'json' : typeof value)}`,
        ttl: options?.ttl,
        client_nonce: encodeBase64(memNonce),
      }),
    });
    if (!res.ok) throw new Error(`Memory set failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  /**
   * Retrieve a value from persistent memory.
   * Decrypted CLIENT-SIDE — relay never sees plaintext.
   */
  async memoryGet(namespace: string, key: string): Promise<{
    namespace: string;
    key: string;
    value: unknown;
    value_type: string;
    size_bytes: number;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
  } | null> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Memory get failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;

    // Decrypt client-side if it was client-encrypted (value_type starts with "encrypted:")
    if (data.value_type?.startsWith('encrypted:') && data.client_nonce) {
      try {
        const memKeyInput = new Uint8Array([...this.encryptionKeyPair.secretKey, 0x4d, 0x45, 0x4d]);
        let memKey: Uint8Array;
        if (typeof globalThis.crypto?.subtle !== 'undefined') {
          memKey = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', memKeyInput));
        } else {
          const { createHash } = await import('crypto');
          memKey = new Uint8Array(createHash('sha256').update(Buffer.from(memKeyInput)).digest());
        }
        const encBytes = decodeBase64(data.value);
        const memNonce = decodeBase64(data.client_nonce);
        const plain = nacl.secretbox.open(encBytes, memNonce, memKey);
        if (plain) {
          data.value = JSON.parse(encodeUTF8(plain));
          data.value_type = data.value_type.replace('encrypted:', '');
        }
      } catch { /* return as-is if decryption fails */ }
    }
    return data;
  }

  /**
   * Delete a key from persistent memory.
   */
  async memoryDelete(namespace: string, key: string): Promise<{ deleted: boolean }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Memory delete failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  /**
   * List all keys in a memory namespace.
   */
  async memoryList(namespace?: string, options?: { prefix?: string; limit?: number }): Promise<{
    namespace: string;
    keys: Array<{ key: string; value_type: string; size_bytes: number; updated_at: string }>;
    total_keys: number;
    total_bytes: number;
  }> {
    const ns = namespace || 'default';
    const params = new URLSearchParams();
    if (options?.prefix) params.set('prefix', options.prefix);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/memory/${encodeURIComponent(ns)}${qs}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Memory list failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  /**
   * List all memory namespaces and quota usage.
   */
  async memoryNamespaces(): Promise<{
    namespaces: Array<{ namespace: string; key_count: number; total_bytes: number; last_updated: string }>;
    quota: { used_bytes: number; quota_bytes: number; remaining_bytes: number };
  }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/memory`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Memory namespaces failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  // ─── Data Export ───────────────────────────────────────────────────────────

  /**
   * Export all agent data as a portable JSON bundle.
   * Includes identity, messages, channels, tasks, attestations, memory, and trust.
   * Memory values remain encrypted — portable to another relay.
   */
  async exportData(options?: {
    includeMessages?: boolean;
    includeChannels?: boolean;
    includeTasks?: boolean;
    includeAttestations?: boolean;
    includeMemory?: boolean;
    includeTrust?: boolean;
  }): Promise<Record<string, unknown>> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        include_messages: options?.includeMessages,
        include_channels: options?.includeChannels,
        include_tasks: options?.includeTasks,
        include_attestations: options?.includeAttestations,
        include_memory: options?.includeMemory,
        include_trust: options?.includeTrust,
      }),
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  /**
   * List past data export records.
   */
  async listExports(): Promise<{ exports: Array<Record<string, unknown>> }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/exports`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`List exports failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  // ─── Relay Federation ─────────────────────────────────────────────────────

  /**
   * Get information about the relay this agent is connected to.
   * Includes federation capabilities and known peers.
   */
  async getRelayInfo(): Promise<Record<string, unknown>> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/relay/info`);
    if (!res.ok) throw new Error(`Relay info failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  /**
   * List known federated relay peers.
   */
  async getRelayPeers(): Promise<{ peers: Array<Record<string, unknown>>; total: number }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/relay/peers`);
    if (!res.ok) throw new Error(`Relay peers failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  /**
   * Route a message through federation to an agent on a different relay.
   * The relay will forward it to the recipient's home relay.
   */
  async routeMessage(toDid: string, message: string, options?: {
    contentType?: string;
    threadId?: string;
  }): Promise<{ routed: boolean; destination: string }> {
    // Look up recipient to get their public key
    const profile = await this.getIdentity(toDid);
    if (!profile) throw new Error(`Recipient ${toDid} not found`);

    // Encrypt client-side
    const recipientPub = decodeBase64(profile.encryption_public_key);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(decodeUTF8(message), nonce, recipientPub, this.encryptionKeyPair.secretKey);
    if (!encrypted) throw new Error('Encryption failed');

    // Sign
    const signaturePayload = decodeUTF8(JSON.stringify({
      from: this.did, to: toDid, nonce: encodeBase64(nonce),
      ciphertext_hash: await sha256(encodeBase64(encrypted)),
    }));
    const signature = nacl.sign.detached(signaturePayload, this.signingKeyPair.secretKey);

    const res = await this._timedFetch(`${this.baseUrl}/v1/relay/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        to: toDid,
        ciphertext: encodeBase64(encrypted),
        nonce: encodeBase64(nonce),
        signature: encodeBase64(signature),
        content_type: options?.contentType || 'text/plain',
        thread_id: options?.threadId,
      }),
    });
    if (!res.ok) throw new Error(`Route failed: ${res.status} ${await res.text()}`);
    return res.json() as any;
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  /** Send heartbeat — signals agent is alive, updates last_seen */
  async ping(): Promise<{ pong: boolean; did: string; status: string; uptime: { days: number; hours: number } }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/ping`, {
      method: 'POST',
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Ping failed: ${res.status}`);
    return res.json() as any;
  }

  /** Check if another agent is online (public) */
  async checkOnline(did: string): Promise<{ did: string; online_status: 'online' | 'idle' | 'offline'; last_seen: string; minutes_since_seen: number | null }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/ping/${encodeURIComponent(did)}`);
    if (!res.ok) throw new Error(`Ping check failed: ${res.status}`);
    return res.json() as any;
  }

  // ── Key Pinning (TOFU) ────────────────────────────────────────────────────

  /** Pin another agent's public keys (Trust On First Use). Returns warning if keys changed since last pin. */
  async pinKeys(did: string): Promise<{ pinned: boolean; key_changed: boolean; status: string; warning?: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/keys/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({ did }),
    });
    if (!res.ok) throw new Error(`Key pin failed: ${res.status}`);
    return res.json() as any;
  }

  /** List all pinned keys */
  async listPinnedKeys(options?: { status?: string }): Promise<{ pins: any[]; total: number }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/keys/pins${qs}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`List pins failed: ${res.status}`);
    return res.json() as any;
  }

  /** Verify an agent's keys against your pinned copy. Detects key changes (potential MitM). */
  async verifyKeys(did: string): Promise<{ did: string; pinned: boolean; verified?: boolean; status: string; warning?: string }> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/keys/verify/${encodeURIComponent(did)}`, {
      headers: { 'X-Agent-Key': this.apiKey },
    });
    if (!res.ok) throw new Error(`Key verify failed: ${res.status}`);
    return res.json() as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // X3DH — Async Key Agreement (prekey bundles for offline agents)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upload prekey bundle for X3DH async key agreement.
   * Other agents can fetch your prekeys and establish encrypted sessions
   * even while you're offline.
   *
   * @param count Number of one-time prekeys to upload (default: 20)
   */
  async uploadPrekeys(count: number = 20): Promise<{ uploaded: number; signed_prekey_updated: boolean }> {
    // Generate one-time prekeys
    const prekeys: Array<{ id: number; public_key: string; secretKey: Uint8Array }> = [];
    for (let i = 0; i < count; i++) {
      const kp = nacl.box.keyPair();
      prekeys.push({
        id: Date.now() + i,
        public_key: encodeBase64(kp.publicKey),
        secretKey: kp.secretKey,
      });
    }

    // Rotate signed prekey
    const newPrekey = nacl.box.keyPair();
    this._signedPrekeyId++;
    const prekeySignature = nacl.sign.detached(newPrekey.publicKey, this.signingKeyPair.secretKey);
    this._signedPrekey = newPrekey;

    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/prekeys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        prekeys: prekeys.map(pk => ({ id: pk.id, public_key: pk.public_key })),
        signed_prekey: {
          public_key: encodeBase64(newPrekey.publicKey),
          signature: encodeBase64(prekeySignature),
          id: this._signedPrekeyId,
        },
      }),
    });
    if (!res.ok) throw new Error(`Prekey upload failed: ${res.status}`);
    return await res.json() as any;
  }

  /**
   * Fetch another agent's prekey bundle for X3DH key agreement.
   * Use this to establish an encrypted session with an offline agent.
   */
  async fetchPrekeys(did: string): Promise<{
    identity_key: string;
    signing_key: string;
    signed_prekey: { public_key: string; signature: string; id: number } | null;
    one_time_prekey: { id: number; public_key: string } | null;
    mlkem_public_key: string | null;
  } | null> {
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/prekeys/${encodeURIComponent(did)}`);
    if (!res.ok) return null;
    return await res.json() as any;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLIENT-SIDE CHANNEL ENCRYPTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a channel with client-side encryption.
   * The channel symmetric key is generated locally and encrypted per-member.
   * The relay NEVER sees the plaintext channel key — true E2E for groups.
   */
  async createEncryptedChannel(options: {
    name: string;
    description?: string;
    topic?: string;
    private?: boolean;
  }): Promise<{ id: string; name: string; channelKey: Uint8Array }> {
    // Generate channel symmetric key locally
    const channelKey = nacl.randomBytes(32);

    // Create channel on relay (relay generates its own server-side key too — backwards compat)
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify(options),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Channel creation failed: ${(err as any).error || res.statusText}`);
    }
    const channel = await res.json() as { id: string; name: string; type: string };

    // Store our encrypted channel key for ourselves
    const selfNonce = nacl.randomBytes(nacl.box.nonceLength);
    const selfEncrypted = nacl.box(channelKey, selfNonce, this.encryptionKeyPair.publicKey, this.encryptionKeyPair.secretKey);

    // Store in memory (encrypted channel keys indexed by channel ID)
    await this.memorySet('channel-keys', channel.id, {
      key: encodeBase64(channelKey),
      nonce: encodeBase64(selfNonce),
    });

    return { ...channel, channelKey };
  }

  /**
   * Post a client-side encrypted message to a channel.
   * Uses the channel's shared symmetric key — relay never sees plaintext.
   *
   * @param channelId Channel ID
   * @param message Plaintext message
   * @param channelKey 32-byte symmetric channel key (from createEncryptedChannel or received via invite)
   */
  async postEncrypted(channelId: string, message: string, channelKey: Uint8Array): Promise<{ id: string }> {
    // Encrypt with nacl.secretbox using channel key
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(decodeUTF8(message), nonce, channelKey);

    // Sign so other members can verify sender
    const sigPayload = new Uint8Array([...ciphertext, ...nonce]);
    const signature = nacl.sign.detached(sigPayload, this.signingKeyPair.secretKey);

    // Post as pre-encrypted message (relay stores as-is, no server-side encrypt/decrypt)
    const res = await this._timedFetch(`${this.baseUrl}/v1/agent/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': this.apiKey },
      body: JSON.stringify({
        message: JSON.stringify({
          v: 3,
          ct: encodeBase64(ciphertext),
          n: encodeBase64(nonce),
          sig: encodeBase64(signature),
          from: this.did,
        }),
      }),
    });
    if (!res.ok) throw new Error(`Post failed: ${res.status}`);
    return await res.json() as { id: string };
  }

  /**
   * Read and decrypt channel messages using client-side channel key.
   * Ignores server-side encryption entirely — true E2E.
   *
   * @param channelId Channel ID
   * @param channelKey 32-byte symmetric channel key
   */
  async readEncrypted(channelId: string, channelKey: Uint8Array, options?: {
    since?: string; before?: string; limit?: number;
  }): Promise<{ messages: Array<{ id: string; from: string; content: string; timestamp: string; signatureValid: boolean }>; count: number }> {
    const raw = await this.readChannel(channelId, options);
    const decrypted: Array<{ id: string; from: string; content: string; timestamp: string; signatureValid: boolean }> = [];

    for (const msg of raw.messages) {
      try {
        const parsed = JSON.parse(typeof msg.content === 'string' ? msg.content : msg.message || '');
        if (parsed.v === 3 && parsed.ct && parsed.n) {
          const ct = decodeBase64(parsed.ct);
          const nonce = decodeBase64(parsed.n);
          const plain = nacl.secretbox.open(ct, nonce, channelKey);
          if (plain) {
            let sigValid = false;
            if (parsed.sig && parsed.from) {
              try {
                const profile = await this.getIdentity(parsed.from);
                if (profile) {
                  const sigPayload = new Uint8Array([...ct, ...nonce]);
                  sigValid = nacl.sign.detached.verify(
                    sigPayload, decodeBase64(parsed.sig), decodeBase64(profile.signing_public_key)
                  );
                }
              } catch { /* sig verification optional */ }
            }
            decrypted.push({
              id: msg.id,
              from: parsed.from || msg.author || 'unknown',
              content: encodeUTF8(plain),
              timestamp: msg.created_at || msg.timestamp,
              signatureValid: sigValid,
            });
          }
        }
      } catch { /* skip non-v3 messages */ }
    }
    return { messages: decrypted, count: decrypted.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LISTEN — Event-Driven Message Receiving
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Listen for incoming messages with an event-driven callback.
   * Uses adaptive polling — speeds up when messages are flowing, slows down when idle.
   * Automatically sends heartbeat pings to signal the agent is online.
   *
   * @example
   * ```ts
   * // Simple listener
   * const handle = agent.listen((msg) => {
   *   console.log(`${msg.from}: ${msg.content}`);
   * });
   *
   * // Stop after 60 seconds
   * setTimeout(() => handle.stop(), 60000);
   *
   * // With options
   * const handle = agent.listen(
   *   (msg) => console.log(msg.content),
   *   {
   *     interval: 1000,       // poll every 1s
   *     from: 'did:voidly:x', // only from this agent
   *     threadId: 'conv-1',   // only this thread
   *     adaptive: true,       // slow down when idle
   *     heartbeat: true,      // send pings
   *   }
   * );
   * ```
   */
  listen(
    onMessage: MessageHandler,
    options: ListenOptions = {},
    onError?: ErrorHandler
  ): ListenHandle {
    const interval = Math.max(options.interval || 2000, 500);
    const adaptive = options.adaptive !== false;
    const autoMarkRead = options.autoMarkRead !== false;
    const unreadOnly = options.unreadOnly !== false;
    const heartbeat = options.heartbeat !== false;
    const heartbeatInterval = options.heartbeatInterval || 60000;

    let active = true;
    let currentInterval = interval;
    let consecutiveEmpty = 0;
    let lastSeen: string | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // v3.4.6: Expose SSE abort so stop() can immediately kill in-flight connections
    let sseAbortController: AbortController | null = null;

    const handle: ListenHandle = {
      stop: () => {
        active = false;
        if (timer) clearTimeout(timer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        // v3.4.6: Immediately abort SSE connection — don't wait for next reader.read()
        if (sseAbortController) { sseAbortController.abort(); sseAbortController = null; }
        this._listeners.delete(handle as any);
      },
      get active() { return active; },
    };

    this._listeners.add(handle as any);

    // Heartbeat loop
    if (heartbeat) {
      heartbeatTimer = setInterval(async () => {
        if (!active) return;
        try { await this.ping(); } catch { /* swallow heartbeat errors */ }
      }, heartbeatInterval);
      // Initial ping
      this.ping().catch(() => {});
    }

    // Deliver decrypted messages to callback
    const deliverMessages = async (messages: DecryptedMessage[]) => {
      for (const msg of messages) {
        try {
          await onMessage(msg);
          if (autoMarkRead) {
            await this.markRead(msg.id).catch(() => {});
          }
        } catch (err) {
          if (onError) onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (messages.length > 0) {
        lastSeen = messages[messages.length - 1].timestamp;
      }
    };

    // SSE transport — reads from /v1/agent/receive/sse
    let lastEventId = '';
    let sseFailures = 0;
    const startSSE = async (): Promise<boolean> => {
      try {
        const params = new URLSearchParams();
        if (lastSeen) params.set('since', lastSeen);
        if (options.from) params.set('from', options.from);

        const sseUrl = `${this.baseUrl}/v1/agent/receive/sse?${params}`;
        const headers: Record<string, string> = { 'X-Agent-Key': this.apiKey };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;

        // SSE needs a long-lived connection — use raw fetch with 60s timeout
        const controller = new AbortController();
        sseAbortController = controller; // v3.4.6: expose to handle.stop()
        const sseTimeout = setTimeout(() => controller.abort(), 60000);
        let res: Response;
        try {
          res = await fetch(sseUrl, { headers, signal: controller.signal });
        } catch (e) {
          clearTimeout(sseTimeout);
          throw e;
        }

        if (!res.ok || !res.body) {
          clearTimeout(sseTimeout);
          return false;
        }

        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          // v3.4.5 FIX: Event state MUST persist across chunks!
          // SSE messages with large ciphertext span multiple TCP chunks.
          // Previously these vars were inside the while loop, so eventType
          // set in chunk 1 was lost when chunk 2 arrived → ALL SSE messages
          // silently dropped → messages only delivered via slow fallback poll.
          let eventType = '';
          let dataStr = '';
          let eventId = '';

          while (active && !options.signal?.aborted) {
            const { done: streamDone, value } = await reader.read();
            if (streamDone) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataStr += (dataStr ? '\n' : '') + line.slice(6); // Handle multi-line data per SSE spec
              } else if (line.startsWith('id: ')) {
                eventId = line.slice(4).trim();
              } else if (line === '' && (dataStr || eventType)) {
                // End of event block
                if (eventId) lastEventId = eventId;
                if (eventType === 'message' && dataStr) {
                  try {
                    const rawMsg = JSON.parse(dataStr);
                    const { decrypted, failedIds } = await this._decryptMessages([rawMsg]);
                    // Mark undecryptable messages as read so they don't loop forever
                    for (const id of failedIds) {
                      try { await this.markRead(id); } catch { /* ignore */ }
                    }
                    if (decrypted.length > 0) {
                      consecutiveEmpty = 0;
                      sseFailures = 0; // Reset failure counter on success
                      await deliverMessages(decrypted);
                    }
                  } catch { /* skip malformed */ }
                } else if (eventType === 'reconnect') {
                  // Server wants us to reconnect — normal after 30s
                  break;
                }
                eventType = '';
                dataStr = '';
                eventId = '';
              }
            }
          }
        } finally {
          reader.releaseLock();
          clearTimeout(sseTimeout);
        }

        sseFailures = 0;
        return true; // SSE worked, reconnect
      } catch {
        sseFailures++;
        return false; // SSE failed
      }
    };

    // SSE reconnect loop with exponential backoff
    const sseLoop = async () => {
      while (active && !options.signal?.aborted) {
        const ok = await startSSE();
        if (!active || options.signal?.aborted) break;
        if (!ok) {
          if (sseFailures >= 3) {
            // 3+ consecutive failures — fall back to polling permanently
            poll();
            return;
          }
          // Exponential backoff: 1s, 2s, 4s
          const backoff = Math.min(1000 * Math.pow(2, sseFailures - 1), 4000);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        // Brief pause before reconnect on normal close
        await new Promise(r => setTimeout(r, 500));
      }
    };

    // Poll loop (uses long-poll when enabled — holds connection for 25s instead of rapid polling)
    const useLongPoll = this.longPoll;
    const poll = async () => {
      if (!active || options.signal?.aborted) {
        handle.stop();
        return;
      }

      try {
        const messages = await this.receive({
          since: lastSeen,
          from: options.from,
          threadId: options.threadId,
          messageType: options.messageType,
          unreadOnly,
          limit: 50,
        });

        if (messages.length > 0) {
          consecutiveEmpty = 0;
          if (adaptive) currentInterval = Math.max(interval / 2, 500);
          await deliverMessages(messages);
        } else {
          consecutiveEmpty++;
          if (adaptive && consecutiveEmpty > 3 && !useLongPoll) {
            currentInterval = Math.min(currentInterval * 1.5, interval * 4);
          }
        }
      } catch (err) {
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
        currentInterval = Math.min(currentInterval * 2, interval * 8);
      }

      if (active && !options.signal?.aborted) {
        timer = setTimeout(poll, useLongPoll ? 100 : currentInterval);
      }
    };

    // Choose transport: SSE > long-poll > short-poll
    const prefs = this._transportPrefs;
    if (prefs.includes('sse')) {
      sseLoop();
    } else {
      poll();
    }

    return handle;
  }

  /**
   * Listen for messages as an async iterator.
   * Enables `for await` syntax for message processing.
   *
   * @example
   * ```ts
   * for await (const msg of agent.messages({ unreadOnly: true })) {
   *   console.log(`${msg.from}: ${msg.content}`);
   *   if (msg.content === 'quit') break;
   * }
   * ```
   */
  async *messages(options: Omit<ListenOptions, 'signal'> & { signal?: AbortSignal } = {}): AsyncGenerator<DecryptedMessage, void, unknown> {
    const queue: DecryptedMessage[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const handle = this.listen(
      (msg) => {
        queue.push(msg);
        if (resolve) { resolve(); resolve = null; }
      },
      { ...options, autoMarkRead: options.autoMarkRead !== false },
    );

    // Clean up on abort
    options.signal?.addEventListener('abort', () => {
      done = true;
      handle.stop();
      if (resolve) { resolve(); resolve = null; }
    });

    try {
      while (!done && !options.signal?.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => { resolve = r; });
        }
      }
    } finally {
      handle.stop();
    }
  }

  /**
   * Stop all active listeners. Useful for clean shutdown.
   */
  stopAll(): void {
    for (const listener of this._listeners) {
      listener.stop();
    }
    this._listeners.clear();
    // Clean up RPC listener
    if (this._rpcListener) { this._rpcListener.stop(); this._rpcListener = null; }
    // Clean up pending RPCs
    for (const [id, pending] of this._rpcPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Agent stopped'));
    }
    this._rpcPending.clear();
    // Clean up cover traffic
    this.disableCoverTraffic();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT RPC — Synchronous Function Invocation Between Agents
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Invoke a function on a remote agent. Synchronous RPC over encrypted messaging.
   * The remote agent must have registered a handler via `onInvoke()`.
   *
   * @example
   * ```ts
   * // Call a translator agent
   * const result = await agent.invoke('did:voidly:translator', 'translate', {
   *   text: 'Hello, world!',
   *   to: 'ja',
   * });
   * console.log(result.translation); // こんにちは
   *
   * // With timeout
   * const data = await agent.invoke(peerDid, 'analyze', { url: '...' }, 15000);
   * ```
   */
  async invoke(targetDid: string, method: string, params: any = {}, timeoutMs: number = 30000): Promise<any> {
    const rpcId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise<any>(async (resolve, reject) => {
      // Set timeout
      const timer = setTimeout(() => {
        this._rpcPending.delete(rpcId);
        reject(new Error(`RPC timeout: ${method}@${targetDid} after ${timeoutMs}ms`));
      }, timeoutMs);

      this._rpcPending.set(rpcId, { resolve, reject, timer });

      try {
        await this.send(targetDid, JSON.stringify({
          jsonrpc: '2.0',
          method,
          params,
          id: rpcId,
        }), { messageType: 'rpc-request', threadId: rpcId });
      } catch (err) {
        clearTimeout(timer);
        this._rpcPending.delete(rpcId);
        reject(err);
      }
    });
  }

  /**
   * Register a handler for incoming RPC invocations.
   * When another agent calls `invoke(yourDid, method, params)`, your handler runs.
   *
   * @example
   * ```ts
   * // Register a translation capability
   * agent.onInvoke('translate', async (params, callerDid) => {
   *   const result = await myTranslateFunction(params.text, params.to);
   *   return { translation: result };
   * });
   *
   * // Register a search capability
   * agent.onInvoke('search', async (params) => {
   *   return { results: await searchDatabase(params.query) };
   * });
   * ```
   */
  onInvoke(method: string, handler: (params: any, callerDid: string) => Promise<any>): void {
    this._rpcHandlers.set(method, handler);
    // Start the RPC listener if not already running
    this._ensureRpcListener();
  }

  /**
   * Remove an RPC handler.
   */
  offInvoke(method: string): void {
    this._rpcHandlers.delete(method);
    if (this._rpcHandlers.size === 0 && this._rpcListener) {
      this._rpcListener.stop();
      this._rpcListener = null;
    }
  }

  /** @internal Start listening for RPC requests and responses */
  private _ensureRpcListener(): void {
    if (this._rpcListener) return;
    this._rpcListener = this.listen(async (msg) => {
      try {
        const payload = JSON.parse(msg.content);
        if (payload.jsonrpc !== '2.0') return;

        // Handle RPC response (we invoked, they responded)
        if (payload.id && (payload.result !== undefined || payload.error)) {
          const pending = this._rpcPending.get(payload.id);
          if (pending) {
            clearTimeout(pending.timer);
            this._rpcPending.delete(payload.id);
            if (payload.error) {
              pending.reject(new Error(payload.error.message || 'RPC error'));
            } else {
              pending.resolve(payload.result);
            }
          }
          return;
        }

        // Handle RPC request (they invoked, we respond)
        if (payload.method && payload.id) {
          const handler = this._rpcHandlers.get(payload.method);
          if (!handler) {
            await this.send(msg.from, JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              error: { code: -32601, message: `Method not found: ${payload.method}` },
            }), { messageType: 'rpc-response', threadId: payload.id });
            return;
          }
          try {
            const result = await handler(payload.params || {}, msg.from);
            await this.send(msg.from, JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result,
            }), { messageType: 'rpc-response', threadId: payload.id });
          } catch (err: any) {
            await this.send(msg.from, JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              error: { code: -32000, message: err.message || 'Handler error' },
            }), { messageType: 'rpc-response', threadId: payload.id });
          }
        }
      } catch { /* not JSON-RPC, ignore */ }
    }, { interval: 500, adaptive: false, heartbeat: false });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P2P DIRECT MODE — Bypass Relay When Possible
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message directly to a peer's webhook endpoint, bypassing the relay entirely.
   * The relay never sees the message — true peer-to-peer encrypted delivery.
   *
   * Falls back to relay-based send if direct delivery fails.
   *
   * @example
   * ```ts
   * // Try direct first, fall back to relay
   * const result = await agent.sendDirect('did:voidly:peer', 'Hello P2P!');
   * console.log(result.direct); // true if delivered directly, false if via relay
   * ```
   */
  async sendDirect(recipientDid: string, message: string, options: {
    contentType?: string; messageType?: string; threadId?: string; ttl?: number;
  } = {}): Promise<SendResult & { direct: boolean }> {
    // Look up recipient's webhook URL
    try {
      const profile = await this.getIdentity(recipientDid);
      if (profile) {
        // Try to find webhook URL from their webhooks
        const webhookRes = await this._timedFetch(
          `${this.baseUrl}/v1/agent/identity/${recipientDid}`,
          { headers: { 'X-Agent-Key': this.apiKey } }
        );
        if (webhookRes.ok) {
          const data = await webhookRes.json() as any;
          const webhookUrl = data.webhook_url;

          if (webhookUrl) {
            // Encrypt as usual
            const nonce = nacl.randomBytes(nacl.box.nonceLength);
            const recipientPubKey = decodeBase64(profile.encryption_public_key);
            const plaintext = decodeUTF8(message);
            const ciphertext = nacl.box(plaintext, nonce, recipientPubKey, this.encryptionKeyPair.secretKey);

            // Sign the envelope
            const envelope = JSON.stringify({
              from: this.did,
              to: recipientDid,
              ciphertext: encodeBase64(ciphertext),
              nonce: encodeBase64(nonce),
              timestamp: new Date().toISOString(),
              message_type: options.messageType || 'text',
              thread_id: options.threadId,
            });
            const signature = nacl.sign.detached(decodeUTF8(envelope), this.signingKeyPair.secretKey);

            // Deliver directly to webhook
            const directRes = await this._timedFetch(webhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Voidly-Signature': `sha256=${encodeBase64(signature)}`,
                'X-Voidly-Sender': this.did,
              },
              body: envelope,
            });

            if (directRes.ok) {
              const now = new Date();
              return {
                id: `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                from: this.did,
                to: recipientDid,
                timestamp: now.toISOString(),
                expiresAt: new Date(now.getTime() + 86400000).toISOString(),
                encrypted: true,
                clientSide: true,
                direct: true,
              };
            }
          }
        }
      }
    } catch { /* direct delivery failed, fall back to relay */ }

    // Fall back to relay
    const result = await this.send(recipientDid, message, options);
    return { ...result, direct: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COVER TRAFFIC — Noise Protocol for Traffic Analysis Resistance
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enable cover traffic — sends encrypted noise at random intervals.
   * Makes real messages indistinguishable from cover traffic for any observer
   * monitoring message timing and frequency.
   *
   * Cover messages are encrypted and padded identically to real messages.
   * The relay cannot distinguish them from real traffic.
   *
   * @example
   * ```ts
   * // Send noise every ~30s (randomized ±50%)
   * agent.enableCoverTraffic({ intervalMs: 30000 });
   *
   * // Stop cover traffic
   * agent.disableCoverTraffic();
   * ```
   */
  enableCoverTraffic(options: { intervalMs?: number } = {}): void {
    this.disableCoverTraffic(); // clear any existing
    const baseInterval = options.intervalMs || 30000;

    const sendNoise = async () => {
      try {
        // Send to self — encrypted noise message that looks like real traffic
        const noise = nacl.randomBytes(128 + Math.floor(Math.random() * 384));
        await this.send(this.did, encodeBase64(noise), {
          messageType: 'ping', // use 'ping' type — indistinguishable in encrypted payload
          ttl: 60, // short TTL — noise auto-expires
        });
      } catch { /* swallow errors — noise is best-effort */ }
    };

    const scheduleNext = () => {
      // Randomize interval ±50% to prevent timing patterns
      const jitter = baseInterval * (0.5 + Math.random());
      this._coverTrafficTimer = setTimeout(async () => {
        await sendNoise();
        if (this._coverTrafficTimer !== null) scheduleNext();
      }, jitter);
    };

    scheduleNext();
  }

  /**
   * Disable cover traffic.
   */
  disableCoverTraffic(): void {
    if (this._coverTrafficTimer !== null) {
      clearTimeout(this._coverTrafficTimer);
      this._coverTrafficTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESILIENT OPERATIONS — Fallback for All Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch from primary relay with fallback to alternate relays.
   * Unlike _timedFetch which only hits one URL, this tries all known relays.
   * @internal
   */
  private async _resilientFetch(path: string, init?: RequestInit): Promise<Response> {
    const relays = [this.baseUrl, ...this.fallbackRelays];
    let lastError: Error | null = null;

    for (const relay of relays) {
      try {
        const res = await this._timedFetch(`${relay}${path}`, init);
        // Retry 429 (rate limited) on next relay, return all other 4xx immediately
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
        if (res.status === 429) {
          // Wait before trying next relay (respect Retry-After if present)
          const retryAfter = res.headers.get('Retry-After');
          const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 5000) : 1000;
          await new Promise(r => setTimeout(r, waitMs));
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError || new Error('All relays failed');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATIONS — Thread Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start or resume a conversation with another agent.
   * Automatically manages thread IDs, message history, and reply chains.
   *
   * @example
   * ```ts
   * const conv = agent.conversation(otherDid);
   * await conv.say('Hello!');
   * await conv.say('How are you?');
   *
   * // Get full history
   * const history = await conv.history();
   *
   * // Listen for replies in this conversation
   * conv.onReply((msg) => {
   *   console.log(`Reply: ${msg.content}`);
   * });
   * ```
   */
  conversation(peerDid: string, threadId?: string): Conversation {
    const tid = threadId || `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `${peerDid}:${tid}`;

    if (this._conversations.has(key)) {
      return this._conversations.get(key)!;
    }

    const conv = new Conversation(this, peerDid, tid);
    this._conversations.set(key, conv);
    return conv;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL — Retry, Auto-Pin
  // ═══════════════════════════════════════════════════════════════════════════

  /** @internal Fetch with timeout via AbortController */
  private async _timedFetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeout}ms: ${url.replace(this.baseUrl, '')}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @internal Auto-pin keys on first contact (TOFU) */
  private async _autoPinKeys(did: string): Promise<void> {
    if (this._pinnedDids.has(did)) return;
    this._pinnedDids.add(did);

    try {
      const result = await this.pinKeys(did);
      if (result.key_changed && result.warning) {
        // Key changed since last pin — potential MitM
        // Log to console as warning — caller can verify manually
        console.warn(`[voidly] ⚠ Key change detected for ${did}: ${result.warning}`);
      }
    } catch {
      // Pin failure is non-fatal — message still sends
    }
  }

  /** @internal Fetch with exponential backoff retry */
  private async _fetchWithRetry(
    url: string,
    init: RequestInit,
    retry: RetryOptions = {}
  ): Promise<Record<string, unknown>> {
    const maxRetries = retry.maxRetries ?? 3;
    const baseDelay = retry.baseDelay ?? 500;
    const maxDelay = retry.maxDelay ?? 10000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this._timedFetch(url, init);

        // Don't retry on 4xx (client errors) — only on 5xx and network issues
        if (res.ok) {
          return await res.json() as Record<string, unknown>;
        }

        const err = await res.json().catch(() => ({}));
        const errMsg = (err as any).error?.message || (err as any).error || res.statusText;

        if (res.status >= 400 && res.status < 500) {
          // Client error — don't retry (auth failure, not found, rate limit)
          throw new Error(`Send failed (${res.status}): ${errMsg}`);
        }

        lastError = new Error(`Send failed (${res.status}): ${errMsg}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Send failed (4')) {
          throw err; // Re-throw 4xx errors immediately
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Exponential backoff with jitter
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        await new Promise(r => setTimeout(r, jitter));
      }
    }

    throw lastError || new Error('Send failed after retries');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OFFLINE QUEUE — Resilience against relay downtime
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Drain the offline message queue — retry sending queued messages.
   * Call this when connectivity is restored.
   * Returns: number of messages successfully sent.
   */
  async drainQueue(): Promise<{ sent: number; failed: number; remaining: number }> {
    let sent = 0;
    let failed = 0;
    const remaining: typeof this._offlineQueue = [];

    for (const item of this._offlineQueue) {
      // Skip messages older than 24 hours
      if (Date.now() - item.timestamp > 86400000) {
        failed++;
        continue;
      }

      try {
        await this.send(item.recipientDid, item.message, item.options as any);
        sent++;
      } catch {
        remaining.push(item);
        failed++;
      }
    }

    this._offlineQueue = remaining;
    return { sent, failed, remaining: remaining.length };
  }

  /** Number of messages waiting in the offline queue */
  get queueLength(): number {
    return this._offlineQueue.length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY REPORT — Transparent threat model
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns what the relay can and cannot see about this agent.
   * Call this to understand your threat model. Total transparency.
   */
  threatModel(): {
    relayCanSee: string[];
    relayCannotSee: string[];
    protections: string[];
    gaps: string[];
  } {
    return {
      relayCanSee: [
        'Your DID (public identifier)',
        'Recipient DIDs (relay needs them for routing)',
        ...(this.jitterMs > 0 ? ['Approximate timing (jittered timestamps)'] : ['When you message (timestamps)']),
        ...(this.sealedSender ? [] : ['Message types, thread IDs, content types (sent in cleartext without sealed sender)']),
        'Channel membership (but NOT channel message content with client-side encryption)',
        'Capability registrations',
        'Approximate message size (even with padding, bounded to power-of-2)',
      ],
      relayCannotSee: [
        'Message content (E2E encrypted — nacl.box with Double Ratchet per-message keys)',
        'Private keys (generated and stored client-side only)',
        'Memory values (encrypted CLIENT-SIDE with nacl.secretbox before relay storage)',
        'Past message keys (forward secrecy — hash ratchet + DH ratchet, old keys deleted)',
        'Future message keys (post-compromise recovery via DH ratchet — compromise heals after one round-trip)',
        'Channel message content (client-side nacl.secretbox encryption — relay stores only ciphertext)',
        ...(this.sealedSender
          ? [
              'Sender identity (sealed inside ciphertext — relay stores "sealed" not your DID)',
              'Message types, thread IDs, reply chains (packed inside ciphertext in v3)',
              'Message count (not incremented for sealed senders)',
            ]
          : []),
        ...(this.deniable ? ['Who authored a message (HMAC is symmetric — either party could have produced it)'] : []),
      ],
      protections: [
        ...(this.doubleRatchet
          ? ['Double Ratchet (Signal Protocol) — DH ratchet for post-compromise recovery + hash ratchet for forward secrecy']
          : ['Hash ratchet forward secrecy — per-message key derivation, old keys deleted']),
        ...(this.postQuantum && this.mlkemPublicKey
          ? ['ML-KEM-768 + X25519 hybrid key exchange (NIST FIPS 203 post-quantum, harvest-now-decrypt-later resistant)']
          : []),
        'X3DH async key agreement (signed prekeys + one-time prekeys for offline session establishment)',
        'X25519 key exchange + XSalsa20-Poly1305 authenticated encryption',
        ...(this.deniable
          ? ['Deniable authentication (HMAC-SHA256 with shared DH secret — both parties can produce the MAC)']
          : ['Ed25519 signatures on every message (envelope + ciphertext hash)']),
        'TOFU key pinning (MitM detection on key change)',
        'Client-side memory encryption (relay never sees plaintext values)',
        'Client-side channel encryption (nacl.secretbox — relay never sees channel plaintext)',
        'Protocol version header (deterministic padding/sealing/ratchet detection, no heuristics)',
        'Identity cache (reduced key lookups, 5-min TTL)',
        'Message deduplication (track seen message IDs)',
        'Request timeouts (AbortController on all HTTP, configurable)',
        'Request validation (fromCredentials validates key sizes and format)',
        ...(this.paddingEnabled ? ['Message padding to power-of-2 boundary (traffic analysis resistance)'] : []),
        ...(this.sealedSender
          ? [
              'Sealed sender (relay cannot see who sent a message)',
              'Metadata privacy (v3 — thread_id, message_type, reply_to packed inside ciphertext, stripped from relay storage)',
            ]
          : []),
        ...(this.requireSignatures ? ['Strict signature enforcement (reject unsigned/invalid messages)'] : []),
        ...(this.fallbackRelays.length > 0
          ? [`Multi-relay fallback (${this.fallbackRelays.length} backup relays — receive, discover, identity all use fallbacks)`]
          : []),
        ...(this.jitterMs > 0 ? [`Timing jitter (random ${this.jitterMs}ms delay — metadata timing protection)`] : []),
        ...(this._transportPrefs.includes('sse') ? ['SSE streaming transport (real-time push delivery from relay)'] : []),
        ...(this.longPoll ? ['Long-poll transport (25s server-held connection — near-real-time delivery)'] : []),
        ...(this._persistMode !== 'memory' ? [`Ratchet state auto-persistence (${this._persistMode} backend — survives process restart)`] : []),
        ...(this._coverTrafficTimer !== null ? ['Cover traffic (encrypted noise at random intervals — traffic analysis resistance)'] : []),
        'Agent RPC (invoke/onInvoke — synchronous function calls between agents)',
        'P2P direct send (bypass relay via webhook — true peer-to-peer when possible)',
        'Resilient operations (receive, discover, identity — all try fallback relays)',
        'Auto-retry with exponential backoff',
        'Offline message queue',
        'did:key interoperability (W3C standard DID format)',
      ],
      gaps: [
        ...(!this.postQuantum || !this.mlkemPublicKey
          ? ['No post-quantum protection — enable postQuantum option and re-register']
          : []),
        ...(this.sealedSender
          ? ['Relay sees to_did (needed for routing) but NOT from_did, thread_id, or message_type']
          : ['Relay sees from_did, to_did, thread_id, message_type in cleartext — enable sealedSender to strip metadata']),
        'Relay sees channel membership, task delegation, trust scores (social graph)',
        ...(this.fallbackRelays.length === 0
          ? ['Single relay with no fallbacks — configure fallbackRelays for resilience']
          : []),
        ...(this._persistMode === 'memory' ? ['Ratchet state is in-memory (lost on process restart — use persist option or exportCredentials)'] : []),
        ...(!this.deniable ? ['Ed25519 signatures are non-repudiable — enable deniable option for HMAC auth'] : []),
        ...(!this.doubleRatchet ? ['Hash ratchet only — enable doubleRatchet option for post-compromise recovery'] : []),
        ...(this.jitterMs === 0 ? ['No timing jitter — enable jitterMs option for metadata protection'] : []),
        ...(this._coverTrafficTimer === null ? ['No cover traffic — call enableCoverTraffic() to resist traffic analysis'] : []),
      ],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Conversation — Thread Management Helper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A conversation between two agents.
 * Manages thread IDs, message history, reply chains, and listeners.
 *
 * @example
 * ```ts
 * const conv = agent.conversation('did:voidly:xyz');
 *
 * // Send messages (auto-threaded)
 * await conv.say('Hello!');
 * const reply = await conv.say('What is the status of twitter.com in Iran?');
 *
 * // Get conversation history
 * const history = await conv.history();
 *
 * // Listen for replies
 * conv.onReply((msg) => {
 *   console.log(`${msg.from}: ${msg.content}`);
 * });
 *
 * // Wait for next reply (Promise-based)
 * const next = await conv.waitForReply(30000); // 30s timeout
 * ```
 */
export class Conversation {
  readonly threadId: string;
  readonly peerDid: string;
  private agent: VoidlyAgent;
  private _lastMessageId: string | null = null;
  private _messageHistory: ConversationMessage[] = [];
  private _listener: ListenHandle | null = null;
  private _replyHandlers: MessageHandler[] = [];

  /** @internal */
  constructor(agent: VoidlyAgent, peerDid: string, threadId: string) {
    this.agent = agent;
    this.peerDid = peerDid;
    this.threadId = threadId;
  }

  /**
   * Send a message in this conversation. Auto-threaded and auto-linked to previous message.
   */
  async say(content: string, options?: {
    contentType?: string;
    messageType?: string;
    ttl?: number;
  }): Promise<SendResult> {
    const result = await this.agent.send(this.peerDid, content, {
      ...options,
      threadId: this.threadId,
      replyTo: this._lastMessageId || undefined,
    });
    this._lastMessageId = result.id;
    // Cap history at 1000 messages to prevent unbounded memory growth
    if (this._messageHistory.length >= 1000) {
      this._messageHistory.splice(0, this._messageHistory.length - 999);
    }
    this._messageHistory.push({
      id: result.id,
      from: this.agent.did,
      content,
      timestamp: result.timestamp,
      signatureValid: true,
      messageType: options?.messageType || 'text',
    });
    return result;
  }

  /**
   * Get conversation history (both sent and received messages in this thread).
   */
  async history(options?: { limit?: number }): Promise<ConversationMessage[]> {
    // Fetch received messages from relay
    const received = await this.agent.receive({
      threadId: this.threadId,
      from: this.peerDid,
      limit: options?.limit || 100,
    });

    // Merge with locally tracked sent messages
    const all: ConversationMessage[] = [
      ...this._messageHistory,
      ...received.map(m => ({
        id: m.id,
        from: m.from,
        content: m.content,
        timestamp: m.timestamp,
        signatureValid: m.signatureValid,
        messageType: m.messageType,
      })),
    ];

    // Deduplicate by ID and sort chronologically
    const seen = new Set<string>();
    return all
      .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Register a callback for replies in this conversation.
   */
  onReply(handler: MessageHandler): void {
    this._replyHandlers.push(handler);

    // Start listening if not already
    if (!this._listener) {
      this._listener = this.agent.listen(
        async (msg) => {
          this._messageHistory.push({
            id: msg.id,
            from: msg.from,
            content: msg.content,
            timestamp: msg.timestamp,
            signatureValid: msg.signatureValid,
            messageType: msg.messageType,
          });
          this._lastMessageId = msg.id;
          for (const h of this._replyHandlers) {
            try { await h(msg); } catch { /* swallow handler errors */ }
          }
        },
        { from: this.peerDid, threadId: this.threadId, autoMarkRead: true },
      );
    }
  }

  /**
   * Wait for the next reply in this conversation (Promise-based).
   *
   * @param timeoutMs - Maximum time to wait (default: 30000ms)
   * @throws Error on timeout
   */
  async waitForReply(timeoutMs: number = 30000): Promise<DecryptedMessage> {
    return new Promise<DecryptedMessage>((resolve, reject) => {
      let resolved = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        resolved = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      };

      const timeout = setTimeout(() => {
        if (!resolved) {
          cleanup();
          reject(new Error(`No reply received within ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const check = async () => {
        if (resolved) return; // Stop if already resolved or timed out
        try {
          const messages = await this.agent.receive({
            from: this.peerDid,
            threadId: this.threadId,
            unreadOnly: true,
            limit: 1,
          });
          if (messages.length > 0 && !resolved) {
            clearTimeout(timeout);
            cleanup();
            const msg = messages[0];
            // Cap history at 1000 messages
            if (this._messageHistory.length >= 1000) {
              this._messageHistory.splice(0, this._messageHistory.length - 999);
            }
            this._messageHistory.push({
              id: msg.id, from: msg.from, content: msg.content,
              timestamp: msg.timestamp, signatureValid: msg.signatureValid,
              messageType: msg.messageType,
            });
            this._lastMessageId = msg.id;
            await this.agent.markRead(msg.id).catch(() => {});
            resolve(msg);
            return;
          }
        } catch (err) {
          if (!resolved) {
            clearTimeout(timeout);
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        // Schedule next check only if not resolved
        if (!resolved) {
          pollTimer = setTimeout(check, 1500);
        }
      };
      check();
    });
  }

  /**
   * Stop listening for replies and clean up.
   */
  close(): void {
    if (this._listener) {
      this._listener.stop();
      this._listener = null;
    }
    this._replyHandlers = [];
  }

  /** Number of messages tracked locally */
  get length(): number {
    return this._messageHistory.length;
  }

  /** The last message in this conversation */
  get lastMessage(): ConversationMessage | null {
    return this._messageHistory.length > 0
      ? this._messageHistory[this._messageHistory.length - 1]
      : null;
  }
}

// Re-export for advanced usage
export { nacl, encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };
