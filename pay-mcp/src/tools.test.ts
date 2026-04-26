// Smoke tests for the MCP tool registry — confirm tool names, schemas,
// and that handlers route to the SDK methods correctly.

import { describe, expect, it, vi } from "vitest";
import { tools, findTool } from "./tools";

function fakePay(): any {
  return {
    did: "did:voidly:test",
    publicKey: () => "pk-base64",
    balance: vi.fn(async () => ({ balance_credits: 0 })),
    ensureWallet: vi.fn(async () => ({ did: "did:voidly:test" })),
    transfer: vi.fn(async () => ({ transfer_id: "t1", status: "settled" })),
    batchTransfer: vi.fn(async () => ({ batch_id: "b1" })),
    history: vi.fn(async () => ({ transfers: [] })),
    getTransfer: vi.fn(async () => ({ id: "t1" })),
    openEscrow: vi.fn(async () => ({ escrow_id: "e1" })),
    releaseEscrow: vi.fn(async () => ({})),
    refundEscrow: vi.fn(async () => ({})),
    openStream: vi.fn(async () => ({ stream_id: "s1" })),
    appendMeter: vi.fn(async () => ({ this_hash: "h" })),
    finalizeStream: vi.fn(async () => ({ settled_micro: 0 })),
    subscribe: vi.fn(async () => ({ subscription_id: "sub1" })),
    cancelSubscription: vi.fn(async () => ({})),
    createQuote: vi.fn(async () => ({ quote_id: "q1" })),
    verifyPayment: vi.fn(async () => ({ ok: true })),
    fetchWithPay: vi.fn(async () => new Response(JSON.stringify({ data: 1 }), { status: 200 })),
    subscribeWebhook: vi.fn(async () => ({ webhook_id: "w1", secret: "sec" })),
    deleteWebhook: vi.fn(async () => ({})),
    health: vi.fn(async () => ({})),
    manifest: vi.fn(async () => ({})),
    stats: vi.fn(async () => ({})),
    activity: vi.fn(async () => ({})),
    leaderboard: vi.fn(async () => ({})),
    feed: vi.fn(async () => ({})),
    trust: vi.fn(async () => ({})),
  };
}

describe("tools registry", () => {
  it("has unique names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("every tool has description and inputSchema", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeDefined();
    }
  });
  it("findTool returns the matching tool or undefined", () => {
    expect(findTool("agent_pay")?.name).toBe("agent_pay");
    expect(findTool("nonexistent")).toBeUndefined();
  });
  it("includes coverage of all major primitives", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const expected of [
      "agent_pay", "agent_pay_batch", "agent_wallet_balance",
      "agent_escrow_open", "agent_escrow_release",
      "agent_stream_open", "agent_stream_meter", "agent_stream_finalize",
      "agent_subscribe", "agent_subscription_cancel",
      "agent_x402_quote", "agent_x402_verify", "agent_x402_fetch",
      "agent_webhook_subscribe", "agent_webhook_delete",
      "agent_pay_health", "agent_pay_manifest", "agent_pay_stats",
      "agent_pay_activity", "agent_pay_leaderboard", "agent_pay_feed",
      "agent_pay_trust",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("tool handlers route to SDK methods", () => {
  it("agent_pay calls pay.transfer", async () => {
    const pay = fakePay();
    const t = findTool("agent_pay")!;
    await t.handler(pay, { to: "did:voidly:b", amount: 0.5, memo: "hi" });
    expect(pay.transfer).toHaveBeenCalledWith({ to: "did:voidly:b", amount: 0.5, memo: "hi", expiresInMinutes: undefined });
  });
  it("agent_x402_fetch returns parsed JSON body when content-type allows", async () => {
    const pay = fakePay();
    const t = findTool("agent_x402_fetch")!;
    const r = await t.handler(pay, { url: "http://x" }) as any;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: 1 });
  });
  it("agent_stream_meter forwards prev_hash null when omitted", async () => {
    const pay = fakePay();
    const t = findTool("agent_stream_meter")!;
    await t.handler(pay, { stream_id: "s1", seq: 1, delta: 0.001 });
    expect(pay.appendMeter).toHaveBeenCalledWith("s1", 1, null, 0.001, undefined, undefined);
  });
});
