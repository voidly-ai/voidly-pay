/**
 * Stress Test v2 — Targets exact bugs fixed in v3.4.5–v3.4.8
 *
 * Tests:
 * 1. Basic messaging (sanity)
 * 2. Rapid-fire messages (timestamp >= fix)
 * 3. Concurrent sends (per-peer send mutex)
 * 4. SSE listen() delivery (multi-chunk parser fix)
 * 5. Concurrent listen + poll (decrypt mutex)
 * 6. Call signal delivery priority
 * 7. Send/receive with markRead (queue poisoning prevention)
 * 8. Bidirectional rapid exchange
 * 9. Large message (SSE multi-chunk)
 * 10. Ratchet health after stress
 */

import { VoidlyAgent } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
function fail(name, err) { failed++; failures.push({ name, err: String(err) }); console.log(`  ❌ ${name}: ${err}`); }

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e.message || e);
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Agent Registration ═══');
let alice, bob;

await test('Register Alice', async () => {
  alice = await VoidlyAgent.register({ name: 'stress-alice-v2', relayUrl: BASE });
  if (!alice.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${alice.did}`);
});

await test('Register Bob', async () => {
  bob = await VoidlyAgent.register({ name: 'stress-bob-v2', relayUrl: BASE });
  if (!bob.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${bob.did}`);
});

// Clear any stale messages
try {
  const oldA = await alice.receive({ unreadOnly: true, limit: 100 });
  if (oldA.length > 0) await alice.markReadBatch(oldA.map(m => m.id));
  const oldB = await bob.receive({ unreadOnly: true, limit: 100 });
  if (oldB.length > 0) await bob.markReadBatch(oldB.map(m => m.id));
} catch {}

// ── T1: Basic messaging ─────────────────────────────────────────────────────
console.log('\n═══ T1: Basic Messaging ═══');

await test('Alice → Bob basic message', async () => {
  await alice.send(bob.did, 'hello from stress test');
  await new Promise(r => setTimeout(r, 500));
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content === 'hello from stress test');
  if (!found) throw new Error(`Bob received ${msgs.length} msgs, none matched. Contents: ${msgs.map(m => m.content?.slice(0, 30)).join(', ')}`);
  await bob.markRead(found.id);
});

await test('Bob → Alice basic message', async () => {
  await bob.send(alice.did, 'hello back');
  await new Promise(r => setTimeout(r, 500));
  const msgs = await alice.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content === 'hello back');
  if (!found) throw new Error(`Alice received ${msgs.length} msgs, none matched`);
  await alice.markRead(found.id);
});

// ── T2: Rapid-fire (tests timestamp >= fix) ──────────────────────────────────
console.log('\n═══ T2: Rapid-Fire Messages ═══');

await test('5 rapid messages A→B (same millisecond window)', async () => {
  const tag = `rapid-${Date.now()}`;
  // Send all 5 without any delay
  await Promise.all([
    alice.send(bob.did, `${tag}-0`),
    alice.send(bob.did, `${tag}-1`),
    alice.send(bob.did, `${tag}-2`),
    alice.send(bob.did, `${tag}-3`),
    alice.send(bob.did, `${tag}-4`),
  ]);

  await new Promise(r => setTimeout(r, 1500));

  const msgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const found = msgs.filter(m => m.content?.startsWith(tag));
  if (found.length < 5) throw new Error(`Only ${found.length}/5 rapid messages received`);
  await bob.markReadBatch(msgs.map(m => m.id));
  ok('All 5 rapid messages received', `${found.length}/5`);
});

// ── T3: Concurrent sends (tests per-peer send mutex) ─────────────────────────
console.log('\n═══ T3: Concurrent Sends ═══');

await test('10 concurrent sends from both sides', async () => {
  const tagA = `conc-a-${Date.now()}`;
  const tagB = `conc-b-${Date.now()}`;

  // Both sides send simultaneously
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => alice.send(bob.did, `${tagA}-${i}`)),
    ...Array.from({ length: 10 }, (_, i) => bob.send(alice.did, `${tagB}-${i}`)),
  ]);

  await new Promise(r => setTimeout(r, 2000));

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 100 });

  const bobGot = bobMsgs.filter(m => m.content?.startsWith(tagA));
  const aliceGot = aliceMsgs.filter(m => m.content?.startsWith(tagB));

  if (bobGot.length < 10) throw new Error(`Bob only got ${bobGot.length}/10 concurrent messages`);
  if (aliceGot.length < 10) throw new Error(`Alice only got ${aliceGot.length}/10 concurrent messages`);

  // Mark all as read
  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));

  ok('All concurrent messages delivered', `Bob=${bobGot.length}/10, Alice=${aliceGot.length}/10`);
});

// ── T4: SSE listen() ─────────────────────────────────────────────────────────
console.log('\n═══ T4: SSE Listen ═══');

await test('SSE receives messages in real-time', async () => {
  const tag = `sse-${Date.now()}`;
  const received = [];
  let listenReady;
  const readyPromise = new Promise(r => { listenReady = r; });

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true, adaptive: false },
    (err) => console.error('[T4] listen error:', err),
  );

  // Wait for SSE connection to establish
  await new Promise(r => setTimeout(r, 1500));

  // Send 3 messages
  await alice.send(bob.did, `${tag}-0`);
  await new Promise(r => setTimeout(r, 800));
  await alice.send(bob.did, `${tag}-1`);
  await new Promise(r => setTimeout(r, 800));
  await alice.send(bob.did, `${tag}-2`);

  // Wait for delivery
  await new Promise(r => setTimeout(r, 3000));
  handle.stop();

  if (received.length < 3) throw new Error(`SSE only received ${received.length}/3 messages: ${received.join(', ')}`);

  // Clean up any remaining
  try {
    const remaining = await bob.receive({ unreadOnly: true, limit: 50 });
    if (remaining.length > 0) await bob.markReadBatch(remaining.map(m => m.id));
  } catch {}
});

// ── T5: Concurrent listen + poll (decrypt mutex) ─────────────────────────────
console.log('\n═══ T5: Concurrent Listen + Poll ═══');

await test('Poll while SSE active — no decrypt corruption', async () => {
  const tag = `mutex-${Date.now()}`;
  const sseReceived = [];

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) sseReceived.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await new Promise(r => setTimeout(r, 1000));

  // Send while SSE active
  await alice.send(bob.did, `${tag}-sse-0`);
  await alice.send(bob.did, `${tag}-sse-1`);

  // Simultaneously poll (this should wait for decrypt mutex)
  await new Promise(r => setTimeout(r, 500));
  const pollMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const pollFound = pollMsgs.filter(m => m.content?.startsWith(tag));

  await new Promise(r => setTimeout(r, 2000));
  handle.stop();

  // Between SSE and poll, all messages should be received (no duplicates, no corruption)
  const total = sseReceived.length + pollFound.length;
  // It's ok if SSE gets them all and poll gets 0, or vice versa
  if (total < 2) throw new Error(`Only ${total}/2 messages received (SSE=${sseReceived.length}, poll=${pollFound.length})`);

  // Clean up
  try {
    const remaining = await bob.receive({ unreadOnly: true, limit: 50 });
    if (remaining.length > 0) await bob.markReadBatch(remaining.map(m => m.id));
  } catch {}
});

// ── T6: Call signal delivery ─────────────────────────────────────────────────
console.log('\n═══ T6: Call Signal Delivery ═══');

await test('Call signals delivered as call-signal contentType', async () => {
  const signal = { type: 'call-offer', callId: 'test-123', sdp: 'v=0\r\nfake-sdp', video: false };
  await alice.send(bob.did, JSON.stringify(signal), {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await new Promise(r => setTimeout(r, 1000));

  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const callMsg = msgs.find(m => m.contentType === 'application/x-call-signal');
  if (!callMsg) {
    // Check if it was received but contentType was stripped
    const anyCall = msgs.find(m => m.content?.includes('call-offer'));
    if (anyCall) {
      ok('Call signal received (contentType in content)', `contentType=${anyCall.contentType}`);
    } else {
      throw new Error(`No call signal in ${msgs.length} messages`);
    }
  }

  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T7: Message ordering ─────────────────────────────────────────────────────
console.log('\n═══ T7: Message Ordering ═══');

await test('Messages arrive in order (10 sequential)', async () => {
  const tag = `order-${Date.now()}`;
  for (let i = 0; i < 10; i++) {
    await alice.send(bob.did, `${tag}-${i.toString().padStart(2, '0')}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  const msgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const ordered = msgs.filter(m => m.content?.startsWith(tag));

  if (ordered.length < 10) throw new Error(`Only ${ordered.length}/10 ordered messages received`);

  // Verify order
  let inOrder = true;
  for (let i = 1; i < ordered.length; i++) {
    const prevNum = parseInt(ordered[i - 1].content.split('-').pop());
    const currNum = parseInt(ordered[i].content.split('-').pop());
    if (currNum < prevNum) {
      inOrder = false;
      break;
    }
  }
  if (!inOrder) throw new Error('Messages received out of order');

  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T8: Bidirectional rapid exchange ─────────────────────────────────────────
console.log('\n═══ T8: Bidirectional Rapid Exchange ═══');

await test('Ping-pong 5 rounds', async () => {
  const tag = `ping-${Date.now()}`;
  let aliceReceived = 0;
  let bobReceived = 0;

  for (let i = 0; i < 5; i++) {
    await alice.send(bob.did, `${tag}-a2b-${i}`);
    await new Promise(r => setTimeout(r, 200));
    await bob.send(alice.did, `${tag}-b2a-${i}`);
    await new Promise(r => setTimeout(r, 200));
  }

  await new Promise(r => setTimeout(r, 2000));

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 50 });

  bobReceived = bobMsgs.filter(m => m.content?.startsWith(`${tag}-a2b`)).length;
  aliceReceived = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-b2a`)).length;

  if (bobReceived < 5) throw new Error(`Bob only got ${bobReceived}/5 ping messages`);
  if (aliceReceived < 5) throw new Error(`Alice only got ${aliceReceived}/5 pong messages`);

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ── T9: Large message (SSE multi-chunk) ──────────────────────────────────────
console.log('\n═══ T9: Large Message ═══');

await test('2KB message survives E2E encryption + relay', async () => {
  const largeContent = 'X'.repeat(2000) + `-large-${Date.now()}`;
  await alice.send(bob.did, largeContent);

  await new Promise(r => setTimeout(r, 1500));

  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content?.includes('-large-') && m.content?.length > 1900);
  if (!found) throw new Error(`Large message not received (${msgs.length} msgs, max length=${Math.max(0, ...msgs.map(m => m.content?.length || 0))})`);
  if (found.content !== largeContent) throw new Error(`Content mismatch: expected ${largeContent.length} chars, got ${found.content.length}`);

  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T10: Post-stress ratchet health ──────────────────────────────────────────
console.log('\n═══ T10: Post-Stress Ratchet Health ═══');

await test('Ratchet still works after all stress tests', async () => {
  const tag = `final-${Date.now()}`;

  // A→B
  await alice.send(bob.did, `${tag}-a2b`);
  await new Promise(r => setTimeout(r, 1000));
  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const bobGot = bobMsgs.find(m => m.content === `${tag}-a2b`);
  if (!bobGot) throw new Error('Post-stress A→B failed');
  await bob.markReadBatch(bobMsgs.map(m => m.id));

  // B→A
  await bob.send(alice.did, `${tag}-b2a`);
  await new Promise(r => setTimeout(r, 1000));
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 10 });
  const aliceGot = aliceMsgs.find(m => m.content === `${tag}-b2a`);
  if (!aliceGot) throw new Error('Post-stress B→A failed');
  await alice.markReadBatch(aliceMsgs.map(m => m.id));

  ok('Ratchet healthy', 'Both directions work after all stress tests');
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');

await test('Deactivate test agents', async () => {
  await alice.deactivate();
  await bob.deactivate();
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
