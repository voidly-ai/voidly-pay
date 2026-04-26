// Tool definitions for the @voidly/pay-mcp server.
//
// Each tool maps a JSON-Schema-described input to a method on the
// VoidlyPay SDK. Tools are stateless from the server's perspective — the
// VoidlyPay client (with its persisted keypair) does the signing.
//
// Naming: agent_<verb>[_<noun>] keeps consistency with the existing 21
// MCP tools (agent_pay, agent_wallet_balance, etc.). New tools cover
// every primitive added in Stage 1.10–1.16.

import type { VoidlyPay } from "@voidly/pay";

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (pay: VoidlyPay, input: Record<string, any>) => Promise<unknown>;
}

const C = (s: string) => `Voidly Pay: ${s}. Returns JSON.`;

export const tools: Tool[] = [
  // ─── Wallet basics ────────────────────────────────────────────────────
  {
    name: "agent_pay_self",
    description: C("Get the SDK's own DID, public key, and current balance."),
    inputSchema: { type: "object", properties: {} },
    handler: async (pay) => {
      const balance = await pay.balance().catch(() => null);
      return { did: pay.did, public_key_b64: pay.publicKey(), balance };
    },
  },
  {
    name: "agent_wallet_balance",
    description: C("Read the wallet for a DID. Returns balance, locked, caps, frozen flag. If `did` omitted, defaults to self."),
    inputSchema: {
      type: "object",
      properties: { did: { type: "string", description: "did:voidly:... (optional)" } },
    },
    handler: async (pay, input) => await pay.balance(input.did),
  },
  {
    name: "agent_wallet_ensure",
    description: C("Idempotent: create wallet for a DID if it doesn't exist. Useful before sending the first payment."),
    inputSchema: {
      type: "object",
      properties: { did: { type: "string" } },
      required: ["did"],
    },
    handler: async (pay, input) => await pay.ensureWallet(input.did),
  },

  // ─── Transfers ────────────────────────────────────────────────────────
  {
    name: "agent_pay",
    description: C("Sign + settle a one-shot transfer. Amount is in CREDITS (1 credit = 1,000,000 micro). Returns the transfer receipt."),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient did:voidly:..." },
        amount: { type: "number", description: "credits (e.g. 0.5)" },
        memo: { type: "string", description: "optional, ≤280 chars" },
        expires_in_minutes: { type: "number", description: "envelope expiry (default 30)" },
      },
      required: ["to", "amount"],
    },
    handler: async (pay, input) => await pay.transfer({ to: input.to, amount: input.amount, memo: input.memo, expiresInMinutes: input.expires_in_minutes }),
  },
  {
    name: "agent_pay_batch",
    description: C("Atomic multi-recipient transfer. items: [{to, amount, memo?}]. All-or-nothing. Returns batch summary + per-item receipts."),
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { to: { type: "string" }, amount: { type: "number" }, memo: { type: "string" } },
            required: ["to", "amount"],
          },
        },
      },
      required: ["items"],
    },
    handler: async (pay, input) => await pay.batchTransfer(input.items),
  },
  {
    name: "agent_payment_history",
    description: C("Paginated history of transfers for a DID (defaults to self)."),
    inputSchema: {
      type: "object",
      properties: {
        did: { type: "string" },
        limit: { type: "number", description: "default 20, max 200" },
        before: { type: "string", description: "ISO cursor" },
      },
    },
    handler: async (pay, input) => await pay.history({ did: input.did, limit: input.limit, before: input.before }),
  },
  {
    name: "agent_pay_get",
    description: C("Look up a transfer by id. Returns the ledger row including signature, envelope_hash, and status."),
    inputSchema: {
      type: "object",
      properties: { transfer_id: { type: "string" } },
      required: ["transfer_id"],
    },
    handler: async (pay, input) => await pay.getTransfer(input.transfer_id),
  },

  // ─── Escrow ───────────────────────────────────────────────────────────
  {
    name: "agent_escrow_open",
    description: C("Open an escrow hold. Locks `amount` credits from the caller's wallet. Auto-expires past `deadline_hours`."),
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        amount: { type: "number" },
        deadline_hours: { type: "number", description: "default 24, max 168 (7 days)" },
        memo: { type: "string" },
      },
      required: ["to", "amount"],
    },
    handler: async (pay, input) => await pay.openEscrow({ to: input.to, amount: input.amount, deadlineHours: input.deadline_hours, memo: input.memo }),
  },
  {
    name: "agent_escrow_release",
    description: C("Release an open escrow to its recipient. Caller must be the original sender."),
    inputSchema: { type: "object", properties: { escrow_id: { type: "string" } }, required: ["escrow_id"] },
    handler: async (pay, input) => await pay.releaseEscrow(input.escrow_id),
  },
  {
    name: "agent_escrow_refund",
    description: C("Refund an open escrow back to the sender. Caller must be the original sender."),
    inputSchema: {
      type: "object",
      properties: {
        escrow_id: { type: "string" },
        reason: { type: "string", description: "optional ≤280 chars" },
      },
      required: ["escrow_id"],
    },
    handler: async (pay, input) => await pay.refundEscrow(input.escrow_id, input.reason),
  },

  // ─── Streams (per-token billing) ─────────────────────────────────────
  {
    name: "agent_stream_open",
    description: C("Open a metered payment stream. Locks `budget` credits as a max. Provider appends signed meter entries. Use for per-token / per-second billing."),
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "provider's did:voidly:..." },
        budget: { type: "number", description: "max credits" },
        unit_label: { type: "string", description: "e.g. 'tokens', 'ms', 'bytes'" },
        description: { type: "string" },
        deadline_minutes: { type: "number", description: "default 60" },
      },
      required: ["provider", "budget"],
    },
    handler: async (pay, input) => await pay.openStream({
      provider: input.provider, budget: input.budget,
      unitLabel: input.unit_label, description: input.description,
      deadlineMinutes: input.deadline_minutes,
    }),
  },
  {
    name: "agent_stream_meter",
    description: C("Provider-side: append a signed meter entry to an open stream. seq starts at 1 and increments. prev_hash is the last entry's this_hash (or null for seq=1). Returns this_hash for chaining the next."),
    inputSchema: {
      type: "object",
      properties: {
        stream_id: { type: "string" },
        seq: { type: "number", description: "monotonically increasing, ≥1" },
        prev_hash: { type: "string", description: "previous entry's this_hash, or null for seq=1" },
        delta: { type: "number", description: "credits to add to the meter" },
        units: { type: "number", description: "optional unit count (e.g. tokens used)" },
      },
      required: ["stream_id", "seq", "delta"],
    },
    handler: async (pay, input) => await pay.appendMeter(
      input.stream_id, input.seq, input.prev_hash ?? null,
      input.delta, input.units, input.metadata,
    ),
  },
  {
    name: "agent_stream_finalize",
    description: C("Requester-side: finalize a stream. Acknowledges the metered total + last seq + last hash. Settles metered amount to provider, refunds rest to requester."),
    inputSchema: {
      type: "object",
      properties: {
        stream_id: { type: "string" },
        expected_seq: { type: "number" },
        expected_hash: { type: ["string", "null"] },
        metered_total_micro: { type: "number" },
      },
      required: ["stream_id", "expected_seq", "metered_total_micro"],
    },
    handler: async (pay, input) => await pay.finalizeStream(
      input.stream_id, input.expected_seq, input.expected_hash ?? null, input.metered_total_micro,
    ),
  },

  // ─── Subscriptions ────────────────────────────────────────────────────
  {
    name: "agent_subscribe",
    description: C("Create a recurring subscription. Pulls `amount_per_period` from caller's balance every `period_seconds`. Auto-pauses after 3 consecutive failures."),
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string" },
        amount_per_period: { type: "number" },
        period_seconds: { type: "number", description: "min 60" },
        periods_total: { type: "number", description: "optional cap; omit for unlimited" },
        description: { type: "string" },
      },
      required: ["provider", "amount_per_period", "period_seconds"],
    },
    handler: async (pay, input) => await pay.subscribe({
      provider: input.provider,
      amountPerPeriod: input.amount_per_period,
      periodSeconds: input.period_seconds,
      periodsTotal: input.periods_total,
      description: input.description,
    }),
  },
  {
    name: "agent_subscription_cancel",
    description: C("Cancel a subscription. Either party (requester or provider) may cancel."),
    inputSchema: {
      type: "object",
      properties: { subscription_id: { type: "string" }, reason: { type: "string" } },
      required: ["subscription_id"],
    },
    handler: async (pay, input) => await pay.cancelSubscription(input.subscription_id, input.reason),
  },

  // ─── x402 (server-side: take payments) ────────────────────────────────
  {
    name: "agent_x402_quote",
    description: C("Server-side: create an x402 quote. Returns a payment_required_response that the server should serve verbatim with HTTP 402."),
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: "URL path or label" },
        amount: { type: "number", description: "credits" },
        recipient: { type: "string", description: "where to send the money (default: self)" },
        method: { type: "string", description: "HTTP method (optional)" },
        description: { type: "string" },
        ttl_seconds: { type: "number", description: "default 600, max 3600" },
      },
      required: ["resource", "amount"],
    },
    handler: async (pay, input) => await pay.createQuote({
      resource: input.resource, amount: input.amount,
      recipient: input.recipient, method: input.method,
      description: input.description, ttlSeconds: input.ttl_seconds,
    }),
  },
  {
    name: "agent_x402_verify",
    description: C("Server-side: verify + consume an x402 payment. Pass the X-Payment header value the caller sent. Atomic; UNIQUE replay protection at the DB."),
    inputSchema: {
      type: "object",
      properties: {
        payment_header: { type: "string", description: "value of the X-Payment header" },
        quote_id: { type: "string", description: "redundant if payment_header carries it" },
        transfer_id: { type: "string", description: "redundant if payment_header carries it" },
      },
    },
    handler: async (pay, input) => await pay.verifyPayment({
      payment_header: input.payment_header,
      quote_id: input.quote_id,
      transfer_id: input.transfer_id,
    }),
  },

  // ─── x402 (client-side: pay-on-402) ──────────────────────────────────
  {
    name: "agent_x402_fetch",
    description: C("Fetch a URL; if it returns HTTP 402, parse the quote, transfer, retry. Returns the FINAL response status and body. `max_amount` caps how much the agent will pay."),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", description: "default GET" },
        body: { type: "string", description: "optional request body" },
        max_amount: { type: "number", description: "max credits to pay (default 0.01)" },
      },
      required: ["url"],
    },
    handler: async (pay, input) => {
      const r = await pay.fetchWithPay(input.url, {
        method: input.method ?? "GET",
        body: input.body,
      }, { maxAmount: input.max_amount });
      const text = await r.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep as string */ }
      const headers: Record<string, string> = {};
      r.headers.forEach((v: string, k: string) => { headers[k] = v; });
      return { status: r.status, headers, body };
    },
  },

  // ─── Webhooks ─────────────────────────────────────────────────────────
  {
    name: "agent_webhook_subscribe",
    description: C("Subscribe to pay events via HMAC-signed webhook. Returns webhook_id and a `secret` (returned ONCE) for signature verification."),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https only (loopback blocked)" },
        events: {
          type: "array",
          items: { type: "string" },
          description: "filter: ['transfer.settled', 'stream.finalized', ...]; omit for all",
        },
        did_filter: { type: "string", description: "only fire when this DID is involved" },
        description: { type: "string" },
      },
      required: ["url"],
    },
    handler: async (pay, input) => await pay.subscribeWebhook({
      url: input.url, events: input.events,
      didFilter: input.did_filter, description: input.description,
    }),
  },
  {
    name: "agent_webhook_delete",
    description: C("Revoke a webhook subscription owned by the caller."),
    inputSchema: {
      type: "object",
      properties: { webhook_id: { type: "string" } },
      required: ["webhook_id"],
    },
    handler: async (pay, input) => await pay.deleteWebhook(input.webhook_id),
  },

  // ─── Network reads (no signing) ───────────────────────────────────────
  {
    name: "agent_pay_health",
    description: C("System-frozen flag + counts of wallets and 24h-settled transfers."),
    inputSchema: { type: "object", properties: {} },
    handler: async (pay) => await pay.health(),
  },
  {
    name: "agent_pay_manifest",
    description: C("Discovery manifest: every endpoint, schema, defaults, and MCP tool list."),
    inputSchema: { type: "object", properties: {} },
    handler: async (pay) => await pay.manifest(),
  },
  {
    name: "agent_pay_stats",
    description: C("Platform-wide aggregates — capabilities, hires, value settled, top providers, recent activity."),
    inputSchema: { type: "object", properties: {} },
    handler: async (pay) => await pay.stats(),
  },
  {
    name: "agent_pay_activity",
    description: C("Most-recent state changes across all primitives (transfers, escrows, hires, streams, subscriptions). Public; no signing."),
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "1-200, default 50" } },
    },
    handler: async (pay, input) => await pay.activity(input.limit ?? 50),
  },
  {
    name: "agent_pay_leaderboard",
    description: C("Top earners or spenders. metric: earned_24h | earned_total | spent_24h | spent_total | hires_24h."),
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["earned_24h", "earned_total", "spent_24h", "spent_total", "hires_24h"] },
        limit: { type: "number", description: "1-200, default 25" },
      },
    },
    handler: async (pay, input) => await pay.leaderboard(input.metric ?? "earned_24h", input.limit ?? 25),
  },
  {
    name: "agent_pay_feed",
    description: C("Incremental, append-only feed of settled transfers. Use `since` cursor from the previous response's next_since."),
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO cursor" },
        limit: { type: "number", description: "1-200, default 50" },
      },
    },
    handler: async (pay, input) => await pay.feed(input.since, input.limit ?? 50),
  },
  {
    name: "agent_pay_trust",
    description: C("Derived provider+requester stats for a DID — completion rate, rating avg, total earned. Useful before a hire decision."),
    inputSchema: {
      type: "object",
      properties: { did: { type: "string", description: "default self" } },
    },
    handler: async (pay, input) => await pay.trust(input.did),
  },
  {
    name: "agent_pay_health_check",
    description: C(
      "One-call trust report. Aggregates /v1/pay/health + /v1/pay/manifest.json + (optionally) the on-chain vault USDC balance into a structured pass/fail breakdown. Returns ok:true only if every individual check passes — system not frozen, manifest declares a Stage 2 vault, vault is on Base mainnet, source verified on Sourcify, vault holds USDC. Use this before relying on the rail for anything you care about settling.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        rpcUrl: { type: "string", description: "Public Base RPC. Default: https://mainnet.base.org" },
        skipChain: { type: "boolean", description: "Skip the on-chain vault balance read." },
      },
    },
    handler: async (pay, input) => await pay.healthCheck({ rpcUrl: input.rpcUrl, skipChain: input.skipChain }),
  },
];

export function findTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
