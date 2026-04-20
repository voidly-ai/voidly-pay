// SDK tests — canonicalization, signing, and high-level API shape.

import { describe, expect, it } from "vitest";
import { VoidlyPay, canonicalize, sha256Hex, generateKeyPair, MICRO_PER_CREDIT } from "../src/index";

describe("canonicalize", () => {
  it("sorts keys lexicographically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("omits null/undefined values", () => {
    expect(canonicalize({ a: 1, b: null, c: undefined, d: 2 })).toBe('{"a":1,"d":2}');
  });

  it("produces the same bytes regardless of insertion order", () => {
    const a = canonicalize({ x: "hi", n: 1, arr: [1, 2, 3] });
    const b = canonicalize({ arr: [1, 2, 3], n: 1, x: "hi" });
    expect(a).toBe(b);
  });

  it("rejects floats", () => {
    expect(() => canonicalize({ x: 1.5 })).toThrow();
  });

  it("handles nested objects + arrays", () => {
    expect(canonicalize({ a: { c: 2, b: 1 }, arr: [{ y: 1, x: 0 }] })).toBe(
      '{"a":{"b":1,"c":2},"arr":[{"x":0,"y":1}]}',
    );
  });
});

describe("sha256Hex", () => {
  it("returns 64-char lowercase hex", async () => {
    const h = await sha256Hex("");
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("generateKeyPair", () => {
  it("produces did:voidly:* + base64 keys of right lengths", () => {
    const kp = generateKeyPair();
    expect(kp.did).toMatch(/^did:voidly:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(Buffer.from(kp.publicKeyBase64, "base64").length).toBe(32);
    expect(Buffer.from(kp.secretKeyBase64, "base64").length).toBe(64);
  });
});

describe("VoidlyPay", () => {
  it("throws if sign() called without secret", () => {
    const pay = new VoidlyPay({ did: "did:voidly:test" });
    expect(() => pay.sign({ x: 1 })).toThrow(/secretBase64/);
  });

  it("throws if did required but absent", async () => {
    const pay = new VoidlyPay();
    await expect(pay.faucet()).rejects.toThrow(/did in config/);
  });

  it("signs an envelope with a working keypair (roundtrip verify)", async () => {
    const kp = generateKeyPair();
    const pay = new VoidlyPay({ did: kp.did, secretBase64: kp.secretKeyBase64 });
    const env = { schema: "voidly-pay-faucet/v1", did: kp.did, nonce: "n", issued_at: "t", expires_at: "t2" };
    const sig = pay.sign(env);

    // Verify with nacl against the public key:
    const nacl = await import("tweetnacl");
    const { decodeBase64 } = await import("tweetnacl-util");
    const pub = decodeBase64(kp.publicKeyBase64);
    const bytes = new TextEncoder().encode(canonicalize(env as any));
    expect(nacl.default.sign.detached.verify(bytes, decodeBase64(sig), pub)).toBe(true);
  });

  it("MICRO_PER_CREDIT is 1,000,000", () => {
    expect(MICRO_PER_CREDIT).toBe(1_000_000);
  });
});

describe("VoidlyPay HTTP layer (with mocked fetch)", () => {
  it("GETs manifest.json at the right path", async () => {
    let seenUrl = "";
    const pay = new VoidlyPay({
      fetchImpl: async (url: any) => {
        seenUrl = String(url);
        return new Response(JSON.stringify({ schema: "voidly-pay-manifest/v1" }), { status: 200 });
      },
    });
    await pay.manifest();
    expect(seenUrl).toBe("https://api.voidly.ai/v1/pay/manifest.json");
  });

  it("POSTs /v1/pay/transfer with the expected body shape", async () => {
    const kp = generateKeyPair();
    let capturedBody: any = null;
    const pay = new VoidlyPay({
      did: kp.did,
      secretBase64: kp.secretKeyBase64,
      fetchImpl: async (_url: any, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ schema: "voidly-pay-receipt/v1", status: "settled", transfer_id: "tid", envelope_hash: "h" }),
          { status: 200 },
        );
      },
    });
    const res = await pay.pay({ to: "did:voidly:bob", amountCredits: 0.5, memo: "test" });
    expect(res.status).toBe("settled");
    expect(capturedBody.envelope.schema).toBe("voidly-credit-transfer/v1");
    expect(capturedBody.envelope.from_did).toBe(kp.did);
    expect(capturedBody.envelope.to_did).toBe("did:voidly:bob");
    expect(capturedBody.envelope.amount_micro).toBe(500_000);
    expect(capturedBody.envelope.memo).toBe("test");
    expect(typeof capturedBody.signature).toBe("string");
  });
});
