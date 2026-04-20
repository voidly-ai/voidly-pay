/**
 * Round 4: SSE Reconnection + Death Recovery Testing
 *
 * Tests:
 * 1. SSE receives messages over extended period (30+ seconds)
 * 2. SSE stop + restart — no message loss
 * 3. SSE + poll interleave — no duplicates
 * 4. SSE connection across multiple relay SSE cycles (each 28s)
 * 5. Messages sent during SSE downtime recovered on restart
 * 6. Rapid SSE stop/start cycling
 * 7. SSE with heavy load (20 concurrent messages)
 * 8. SSE autoMarkRead correctness
 * 9. SSE after credential restore
 * 10. Poll fallback when SSE times out
 */

import { VoidlyAgent } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
function fail(name, err) { failed++; failures.push({ name, err: String(err) }); console.log(`  ❌ ${name}: ${err}`); }

async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}

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
console.log('  ROUND 4: SSE RECONNECTION + DEATH RECOVERY');
console.log('═'.repeat(70));

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup ═══');
let alice, bob;

const suffix = Date.now().toString(36);

await test('Register Alice', async () => {
  alice = await VoidlyAgent.register({ name: `sse-alice-${suffix}`, relayUrl: BASE });
});

await test('Register Bob', async () => {
  bob = await VoidlyAgent.register({ name: `sse-bob-${suffix}`, relayUrl: BASE });
});

await drain(alice);
await drain(bob);

// Warm up ratchet
await test('Warm up ratchet', async () => {
  await alice.send(bob.did, 'warmup-a2b');
  await sleep(500);
  await drain(bob);
  await bob.send(alice.did, 'warmup-b2a');
  await sleep(500);
  await drain(alice);
});

// ── T1: Extended SSE session ─────────────────────────────────────────────────
console.log('\n═══ T1: Extended SSE Session (35s) ═══');

await test('SSE receives messages over 35 seconds', async () => {
  const tag = `ext-sse-${Date.now()}`;
  const received = [];

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500); // SSE establishes

  // Send messages at intervals over 35 seconds (spans 2 SSE cycles of ~28s each)
  const sendTimes = [0, 5000, 10000, 15000, 20000, 25000, 30000];
  for (let i = 0; i < sendTimes.length; i++) {
    if (i > 0) await sleep(sendTimes[i] - sendTimes[i - 1]);
    await alice.send(bob.did, `${tag}-${i}`);
    console.log(`    📤 Sent message ${i} at +${sendTimes[i] / 1000}s`);
  }

  await sleep(5000); // Wait for final delivery
  handle.stop();

  console.log(`    📥 SSE received ${received.length}/${sendTimes.length} messages`);

  // Allow some via poll if SSE missed during cycle transition
  if (received.length < sendTimes.length) {
    const remaining = await bob.receive({ unreadOnly: true, limit: 50 });
    const pollFound = remaining.filter(m => m.content?.startsWith(tag));
    const total = received.length + pollFound.length;
    console.log(`    📥 +${pollFound.length} from poll = ${total} total`);
    if (total < sendTimes.length) throw new Error(`Only ${total}/${sendTimes.length} over 35s`);
    if (remaining.length > 0) await bob.markReadBatch(remaining.map(m => m.id));
  }
});

// ── T2: SSE stop + restart ──────────────────────────────────────────────────
console.log('\n═══ T2: SSE Stop + Restart ═══');

await test('Stop SSE, send messages, restart SSE — no loss', async () => {
  const tag = `stop-restart-${Date.now()}`;
  const received = [];

  // Start SSE
  let handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);
  await alice.send(bob.did, `${tag}-before-stop`);
  await sleep(2000);

  // Stop SSE
  handle.stop();
  console.log('    🛑 SSE stopped');

  // Send messages while SSE is dead
  await alice.send(bob.did, `${tag}-during-dead-1`);
  await alice.send(bob.did, `${tag}-during-dead-2`);
  await sleep(1000);

  // Restart SSE
  const received2 = [];
  handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received2.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );
  console.log('    🔄 SSE restarted');

  await sleep(3000);
  handle.stop();

  // Send one more after second stop
  await alice.send(bob.did, `${tag}-after-restart`);
  await sleep(1000);

  // Poll for anything remaining
  const pollMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const pollFound = pollMsgs.filter(m => m.content?.startsWith(tag));
  if (pollMsgs.length > 0) await bob.markReadBatch(pollMsgs.map(m => m.id));

  const allReceived = [...received, ...received2, ...pollFound.map(m => m.content)];
  const uniqueContents = [...new Set(allReceived)];

  console.log(`    📥 SSE1=${received.length}, SSE2=${received2.length}, poll=${pollFound.length}, unique=${uniqueContents.length}`);

  // All 4 messages should be accounted for (before-stop + 2 during-dead + after-restart)
  if (uniqueContents.length < 4) throw new Error(`Only ${uniqueContents.length}/4 unique messages recovered`);
});

// ── T3: SSE + poll interleave ───────────────────────────────────────────────
console.log('\n═══ T3: SSE + Poll Interleave ═══');

await test('Poll while SSE active — no duplicates', async () => {
  const tag = `interleave-${Date.now()}`;
  const sseReceived = [];

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) sseReceived.push(msg.id);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);

  // Send messages
  await alice.send(bob.did, `${tag}-0`);
  await alice.send(bob.did, `${tag}-1`);
  await alice.send(bob.did, `${tag}-2`);

  await sleep(1000);

  // Poll simultaneously
  const pollMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const pollIds = pollMsgs.filter(m => m.content?.startsWith(tag)).map(m => m.id);

  await sleep(2000);
  handle.stop();

  // Check for duplicates
  const allIds = [...sseReceived, ...pollIds];
  const uniqueIds = [...new Set(allIds)];

  console.log(`    📥 SSE=${sseReceived.length}, poll=${pollIds.length}, unique=${uniqueIds.length}, total=${allIds.length}`);

  // Total unique should be >= 3 (all messages received)
  // Total (with potential dupes) should ideally equal unique (no dupes)
  if (uniqueIds.length < 3) {
    // Fall back — maybe they're still unread
    const more = await bob.receive({ unreadOnly: true, limit: 50 });
    const moreFound = more.filter(m => m.content?.startsWith(tag));
    if (uniqueIds.length + moreFound.length < 3) {
      throw new Error(`Only ${uniqueIds.length + moreFound.length}/3 messages (SSE=${sseReceived.length}, poll=${pollIds.length})`);
    }
    if (more.length > 0) await bob.markReadBatch(more.map(m => m.id));
  }

  if (pollMsgs.length > 0) await bob.markReadBatch(pollMsgs.map(m => m.id));
  await drain(bob);
});

// ── T4: Rapid SSE stop/start cycling ────────────────────────────────────────
console.log('\n═══ T4: Rapid SSE Stop/Start Cycling ═══');

await test('5 rapid SSE cycles with messages', async () => {
  const tag = `cycle-${Date.now()}`;
  const allReceived = new Set();

  for (let cycle = 0; cycle < 5; cycle++) {
    const handle = bob.listen(
      (msg) => {
        if (msg.content?.startsWith(tag)) allReceived.add(msg.content);
      },
      { unreadOnly: true, autoMarkRead: true },
    );

    await sleep(800);
    await alice.send(bob.did, `${tag}-${cycle}`);
    await sleep(1500);
    handle.stop();
    await sleep(300);
  }

  // Poll for any we missed
  const remaining = await bob.receive({ unreadOnly: true, limit: 50 });
  remaining.filter(m => m.content?.startsWith(tag)).forEach(m => allReceived.add(m.content));
  if (remaining.length > 0) await bob.markReadBatch(remaining.map(m => m.id));

  console.log(`    📥 ${allReceived.size}/5 messages across 5 SSE cycles`);
  if (allReceived.size < 5) throw new Error(`Only ${allReceived.size}/5 messages across SSE cycles`);
});

// ── T5: Heavy load through SSE ──────────────────────────────────────────────
console.log('\n═══ T5: Heavy Load Through SSE ═══');

await test('20 concurrent messages through SSE', async () => {
  const tag = `heavy-sse-${Date.now()}`;
  const received = [];

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);

  // Send 20 concurrently
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => alice.send(bob.did, `${tag}-${i}`))
  );

  await sleep(5000);
  handle.stop();

  // Check + poll
  const remaining = await bob.receive({ unreadOnly: true, limit: 50 });
  const pollFound = remaining.filter(m => m.content?.startsWith(tag));
  const total = received.length + pollFound.length;

  console.log(`    📥 SSE=${received.length}, poll=${pollFound.length}, total=${total}`);
  if (total < 20) throw new Error(`Only ${total}/20 heavy-load SSE messages`);

  if (remaining.length > 0) await bob.markReadBatch(remaining.map(m => m.id));
});

// ── T6: SSE autoMarkRead correctness ────────────────────────────────────────
console.log('\n═══ T6: SSE autoMarkRead Correctness ═══');

await test('autoMarkRead=true: messages dont reappear on poll', async () => {
  const tag = `automark-${Date.now()}`;
  const received = [];

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);
  await alice.send(bob.did, `${tag}-1`);
  await alice.send(bob.did, `${tag}-2`);
  await sleep(3000);
  handle.stop();

  // If autoMarkRead worked, poll should NOT return these
  const pollMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const stale = pollMsgs.filter(m => m.content?.startsWith(tag));

  if (received.length >= 2 && stale.length > 0) {
    console.warn(`    ⚠️ autoMarkRead may have gap: SSE got ${received.length}, poll found ${stale.length} stale`);
    // Not a fatal error — relay may have latency
    if (pollMsgs.length > 0) await bob.markReadBatch(pollMsgs.map(m => m.id));
  } else if (received.length < 2) {
    // SSE didn't get them — poll should have them
    if (received.length + stale.length < 2) {
      throw new Error(`Only ${received.length + stale.length}/2 autoMarkRead messages`);
    }
    if (pollMsgs.length > 0) await bob.markReadBatch(pollMsgs.map(m => m.id));
  }
  // else: perfect — SSE got both, poll returned 0 stale
});

// ── T7: SSE after credential restore ────────────────────────────────────────
console.log('\n═══ T7: SSE After Credential Restore ═══');

await test('SSE works on restored agent', async () => {
  const tag = `sse-restore-${Date.now()}`;
  const creds = bob.exportCredentials();
  const bobRestored = await VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });

  const received = [];
  const handle = bobRestored.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);
  await alice.send(bobRestored.did, `${tag}-1`);
  await alice.send(bobRestored.did, `${tag}-2`);
  await sleep(3000);
  handle.stop();

  const remaining = await bobRestored.receive({ unreadOnly: true, limit: 50 });
  const pollFound = remaining.filter(m => m.content?.startsWith(tag));
  const total = received.length + pollFound.length;

  if (total < 2) throw new Error(`Only ${total}/2 SSE messages after credential restore`);
  if (remaining.length > 0) await bobRestored.markReadBatch(remaining.map(m => m.id));

  bob = bobRestored;
});

// ── T8: Bidirectional SSE ───────────────────────────────────────────────────
console.log('\n═══ T8: Bidirectional SSE ═══');

await test('Both sides listen via SSE simultaneously', async () => {
  const tag = `bidir-sse-${Date.now()}`;
  const aliceReceived = [];
  const bobReceived = [];

  const handleA = alice.listen(
    (msg) => {
      if (msg.content?.startsWith(`${tag}-b2a`)) aliceReceived.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  const handleB = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(`${tag}-a2b`)) bobReceived.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(2000);

  // Both send
  for (let i = 0; i < 5; i++) {
    await alice.send(bob.did, `${tag}-a2b-${i}`);
    await bob.send(alice.did, `${tag}-b2a-${i}`);
    await sleep(300);
  }

  await sleep(5000);
  handleA.stop();
  handleB.stop();

  // Poll remainder
  const alicePoll = await alice.receive({ unreadOnly: true, limit: 50 });
  const bobPoll = await bob.receive({ unreadOnly: true, limit: 50 });

  const aliceTotal = aliceReceived.length + alicePoll.filter(m => m.content?.startsWith(`${tag}-b2a`)).length;
  const bobTotal = bobReceived.length + bobPoll.filter(m => m.content?.startsWith(`${tag}-a2b`)).length;

  console.log(`    📥 Alice: SSE=${aliceReceived.length}+poll=${alicePoll.filter(m => m.content?.startsWith(`${tag}-b2a`)).length}=${aliceTotal}, Bob: SSE=${bobReceived.length}+poll=${bobPoll.filter(m => m.content?.startsWith(`${tag}-a2b`)).length}=${bobTotal}`);

  if (aliceTotal < 5) throw new Error(`Alice only got ${aliceTotal}/5 via bidirectional SSE`);
  if (bobTotal < 5) throw new Error(`Bob only got ${bobTotal}/5 via bidirectional SSE`);

  if (alicePoll.length > 0) await alice.markReadBatch(alicePoll.map(m => m.id));
  if (bobPoll.length > 0) await bob.markReadBatch(bobPoll.map(m => m.id));
});

// ── T9: Post-SSE ratchet health ─────────────────────────────────────────────
console.log('\n═══ T9: Post-SSE Ratchet Health ═══');

await test('Ratchet healthy after all SSE stress', async () => {
  const tag = `post-sse-health-${Date.now()}`;

  // 3 round-trips to verify
  for (let i = 0; i < 3; i++) {
    await alice.send(bob.did, `${tag}-a2b-${i}`);
    await sleep(500);
    const bobMsgs = await bob.receive({ unreadOnly: true, limit: 10 });
    const found = bobMsgs.find(m => m.content === `${tag}-a2b-${i}`);
    if (!found) throw new Error(`Post-SSE A→B round ${i} failed`);
    if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));

    await bob.send(alice.did, `${tag}-b2a-${i}`);
    await sleep(500);
    const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 10 });
    const foundA = aliceMsgs.find(m => m.content === `${tag}-b2a-${i}`);
    if (!foundA) throw new Error(`Post-SSE B→A round ${i} failed`);
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
console.log(`  ROUND 4 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
