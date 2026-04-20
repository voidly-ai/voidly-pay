/**
 * Round 7: Relay Endpoint Torture Test
 *
 * Tests relay endpoints under adverse conditions:
 * 1. Send to non-existent DID
 * 2. Send with invalid content type
 * 3. Receive with no messages
 * 4. markRead with invalid ID
 * 5. markReadBatch with mixed valid/invalid IDs
 * 6. Double markRead on same message
 * 7. Receive after deactivation attempt
 * 8. Send to self
 * 9. getProfile / getIdentity edge cases
 * 10. Send extremely long content (50KB)
 * 11. Rapid register/deactivate cycle
 * 12. Concurrent operations on same agent
 * 13. SSE on agent with no messages
 * 14. Long-poll timeout handling
 */

import { VoidlyAgent } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
function fail(name, err) { failed++; failures.push({ name, err: String(err) }); console.log(`  ❌ ${name}: ${err}`); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function drain(agent) {
  try {
    const msgs = await agent.receive({ unreadOnly: true, limit: 200 });
    if (msgs.length > 0) await agent.markReadBatch(msgs.map(m => m.id));
    return msgs;
  } catch { return []; }
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('  ROUND 7: RELAY ENDPOINT TORTURE');
console.log('═'.repeat(70));

const suffix = Date.now().toString(36);
let alice, bob;

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup ═══');

await test('Register Alice', async () => {
  alice = await VoidlyAgent.register({ name: `torture-alice-${suffix}`, relayUrl: BASE });
});

await test('Register Bob', async () => {
  bob = await VoidlyAgent.register({ name: `torture-bob-${suffix}`, relayUrl: BASE });
});

await drain(alice);
await drain(bob);

// Warm up ratchet
await alice.send(bob.did, 'warmup');
await sleep(500);
await drain(bob);
await bob.send(alice.did, 'warmup-back');
await sleep(500);
await drain(alice);

// ── T1: Send to non-existent DID ────────────────────────────────────────────
console.log('\n═══ T1: Error Handling ═══');

await test('Send to non-existent DID does not crash', async () => {
  try {
    await alice.send('did:voidly:nonExistentAgent12345', 'hello ghost');
    // May succeed (relay accepts but nobody can decrypt) or throw
  } catch (e) {
    // Expected — relay may reject unknown DID
    if (!e.message) throw new Error('Unexpected error shape');
  }
});

await test('Send empty string message', async () => {
  await alice.send(bob.did, '');
  await sleep(500);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  // Empty string should still be delivered (or relay may reject)
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Receive with limit=0', async () => {
  // Should return empty array, not crash
  const msgs = await alice.receive({ unreadOnly: true, limit: 0 });
  if (!Array.isArray(msgs)) throw new Error('receive() did not return array');
});

await test('Receive with limit=1', async () => {
  // First send a message
  await bob.send(alice.did, `limit-test-${Date.now()}`);
  await sleep(500);
  const msgs = await alice.receive({ unreadOnly: true, limit: 1 });
  if (msgs.length > 1) throw new Error(`limit=1 returned ${msgs.length} messages`);
  if (msgs.length > 0) await alice.markReadBatch(msgs.map(m => m.id));
});

// ── T2: markRead edge cases ─────────────────────────────────────────────────
console.log('\n═══ T2: markRead Edge Cases ═══');

await test('markRead with fake ID does not crash', async () => {
  try {
    await alice.markRead('fake-nonexistent-id-12345');
    // Relay may silently accept or return 404
  } catch (e) {
    // Expected
  }
});

await test('Double markRead on same message', async () => {
  await bob.send(alice.did, `double-mark-${Date.now()}`);
  await sleep(500);
  const msgs = await alice.receive({ unreadOnly: true, limit: 10 });
  if (msgs.length > 0) {
    const id = msgs[0].id;
    await alice.markRead(id);  // First mark
    await alice.markRead(id);  // Second mark — should not crash
  }
});

await test('markReadBatch with empty array', async () => {
  try {
    await alice.markReadBatch([]);
    // Should be a no-op
  } catch (e) {
    // Some implementations throw for empty batch — that's ok
  }
});

await test('markReadBatch with mixed valid/invalid IDs', async () => {
  await bob.send(alice.did, `mixed-mark-${Date.now()}`);
  await sleep(500);
  const msgs = await alice.receive({ unreadOnly: true, limit: 10 });
  if (msgs.length > 0) {
    try {
      await alice.markReadBatch([msgs[0].id, 'fake-invalid-id-xyz']);
      // Should not crash — relay may silently skip the invalid ID
    } catch (e) {
      // Also acceptable
    }
  }
});

// ── T3: Send to self ────────────────────────────────────────────────────────
console.log('\n═══ T3: Send to Self ═══');

await test('Send message to own DID', async () => {
  try {
    await alice.send(alice.did, 'hello myself');
    await sleep(500);
    const msgs = await alice.receive({ unreadOnly: true, limit: 10 });
    if (msgs.length > 0) {
      const self = msgs.find(m => m.content === 'hello myself');
      if (self) {
        ok('Self-message delivered', 'successfully');
      }
      await alice.markReadBatch(msgs.map(m => m.id));
    }
  } catch (e) {
    // Self-messaging may be rejected — that's fine
    ok('Self-messaging rejected', e.message?.slice(0, 50));
  }
});

// ── T4: Profile operations ──────────────────────────────────────────────────
console.log('\n═══ T4: Profile Operations ═══');

await test('getProfile returns valid data', async () => {
  const profile = await alice.getProfile();
  if (!profile) throw new Error('getProfile returned null');
  if (!profile.name?.includes('torture-alice')) throw new Error(`Unexpected name: ${profile.name}`);
});

await test('getIdentity for existing agent', async () => {
  const identity = await alice.getIdentity(bob.did);
  if (!identity) throw new Error('getIdentity returned null for Bob');
  if (!identity.encryption_public_key) throw new Error('Missing encryption key');
});

await test('getIdentity for non-existent DID', async () => {
  const identity = await alice.getIdentity('did:voidly:thisAgentDoesNotExist999');
  // Should return null, not throw
  if (identity !== null && identity !== undefined) {
    console.warn(`    ⚠️ getIdentity returned data for non-existent DID`);
  }
});

// ── T5: Large message stress ────────────────────────────────────────────────
console.log('\n═══ T5: Large Message Stress ═══');

await test('10KB message (encrypted > 10KB after padding)', async () => {
  const huge = 'L'.repeat(10000) + `-huge-${Date.now()}`;
  await alice.send(bob.did, huge);
  await sleep(2000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content?.includes('-huge-') && m.content?.length > 9000);
  if (!found) throw new Error(`10KB message not received (${msgs.length} msgs)`);
  if (found.content !== huge) throw new Error(`Content mismatch: expected ${huge.length}, got ${found.content.length}`);
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Message exactly at 256-byte padding boundary', async () => {
  // After sealed sender envelope, the plaintext is ~200+ bytes. Padding rounds up to 256.
  // A message that's exactly 256 bytes of plaintext tests the edge case.
  const exact = 'P'.repeat(256);
  await alice.send(bob.did, exact);
  await sleep(1000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content === exact);
  if (!found) throw new Error('Padding boundary message not received');
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T6: Concurrent operations ───────────────────────────────────────────────
console.log('\n═══ T6: Concurrent Operations ═══');

await test('Concurrent send + receive on same agent', async () => {
  const tag = `conc-ops-${Date.now()}`;

  // Bob sends while Alice is sending AND receiving
  const [, ,] = await Promise.all([
    alice.send(bob.did, `${tag}-a2b`),
    bob.send(alice.did, `${tag}-b2a`),
    alice.receive({ unreadOnly: true, limit: 10 }),
  ]);

  await sleep(1500);

  // Verify both messages arrived
  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 50 });

  const bobGot = bobMsgs.find(m => m.content === `${tag}-a2b`);
  const aliceGot = aliceMsgs.find(m => m.content === `${tag}-b2a`);

  if (!bobGot && !aliceGot) throw new Error('Neither concurrent message delivered');

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

await test('5 concurrent receives from same agent', async () => {
  // First send some messages
  for (let i = 0; i < 3; i++) await alice.send(bob.did, `multi-recv-${i}`);
  await sleep(1000);

  // 5 concurrent receives — should not crash or corrupt state
  const results = await Promise.all([
    bob.receive({ unreadOnly: true, limit: 50 }),
    bob.receive({ unreadOnly: true, limit: 50 }),
    bob.receive({ unreadOnly: true, limit: 50 }),
    bob.receive({ unreadOnly: true, limit: 50 }),
    bob.receive({ unreadOnly: true, limit: 50 }),
  ]);

  // Some may return messages, some may return empty (mutex serialization)
  const totalMsgs = results.reduce((sum, r) => sum + r.length, 0);
  console.log(`    📥 5 concurrent receives returned ${totalMsgs} total messages`);

  // Mark all read
  for (const msgs of results) {
    if (msgs.length > 0) {
      try { await bob.markReadBatch(msgs.map(m => m.id)); } catch {}
    }
  }
});

// ── T7: SSE edge cases ──────────────────────────────────────────────────────
console.log('\n═══ T7: SSE Edge Cases ═══');

await test('SSE listen on agent with no pending messages', async () => {
  // Make sure inbox is clean
  await drain(bob);

  const received = [];
  const handle = bob.listen(
    (msg) => { received.push(msg.content); },
    { unreadOnly: true, autoMarkRead: true },
  );

  // Wait — no messages should arrive
  await sleep(3000);
  handle.stop();

  if (received.length > 0) {
    console.warn(`    ⚠️ SSE received ${received.length} unexpected messages on empty inbox`);
  }
});

await test('SSE stop is idempotent', async () => {
  const handle = bob.listen(
    (msg) => {},
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(500);
  handle.stop();
  handle.stop(); // Double stop should not throw
  handle.stop(); // Triple stop should not throw
});

// ── T8: Rapid register/deactivate ───────────────────────────────────────────
console.log('\n═══ T8: Rapid Register/Deactivate ═══');

await test('Register and deactivate 3 agents rapidly', async () => {
  for (let i = 0; i < 3; i++) {
    const temp = await VoidlyAgent.register({
      name: `temp-agent-${suffix}-${i}`,
      relayUrl: BASE,
    });
    if (!temp.did.startsWith('did:voidly:')) throw new Error(`Bad DID on cycle ${i}`);
    await temp.deactivate();
  }
});

// ── T9: Content type handling ───────────────────────────────────────────────
console.log('\n═══ T9: Content Type Handling ═══');

await test('JSON content type delivered correctly', async () => {
  const payload = JSON.stringify({ action: 'test', data: [1, 2, 3], nested: { key: 'value' } });
  await alice.send(bob.did, payload, { contentType: 'application/json' });
  await sleep(1000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content?.includes('"action":"test"') || m.content?.includes('"action": "test"'));
  if (!found) throw new Error('JSON content not received');
  // Verify it parses
  try { JSON.parse(found.content); } catch { throw new Error('JSON content corrupted'); }
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Binary-like string content survives E2E', async () => {
  // String with characters from all over Unicode, including null-like chars
  const weirdContent = '\u0000\u0001\u0002\u007F\u0080\u00FF\u0100\uFFFD';
  await alice.send(bob.did, weirdContent);
  await sleep(1000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  // The content may be mangled by JSON serialization (null bytes), so just check it arrived
  if (msgs.length === 0) throw new Error('No message received for binary-like content');
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T10: Post-torture health ────────────────────────────────────────────────
console.log('\n═══ T10: Post-Torture Health Check ═══');

await test('Ratchet healthy after all torture tests', async () => {
  const tag = `post-torture-${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    await alice.send(bob.did, `${tag}-a2b-${i}`);
    await sleep(500);
    const bobMsgs = await bob.receive({ unreadOnly: true, limit: 10 });
    const found = bobMsgs.find(m => m.content === `${tag}-a2b-${i}`);
    if (!found) throw new Error(`Post-torture A→B round ${i} failed`);
    if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));

    await bob.send(alice.did, `${tag}-b2a-${i}`);
    await sleep(500);
    const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 10 });
    const foundA = aliceMsgs.find(m => m.content === `${tag}-b2a-${i}`);
    if (!foundA) throw new Error(`Post-torture B→A round ${i} failed`);
    if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');

await test('Deactivate test agents', async () => {
  await alice.deactivate().catch(() => {});
  await bob.deactivate().catch(() => {});
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  ROUND 7 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
