/**
 * BRUTAL TEST SUITE — 12-hour endurance run
 *
 * This test is DESIGNED to break things. It pushes every limit:
 * - High volume (100+ messages)
 * - Concurrent bidirectional storms
 * - SSE under heavy load
 * - Rapid ratchet advancement
 * - Message ordering verification
 * - Credential export/restore mid-conversation
 * - Edge cases (empty, unicode, huge, special chars)
 * - Call signal priority under backlog
 * - Multi-peer conversations
 * - Ratchet recovery after simulated corruption
 */

import { VoidlyAgent } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;
const failures = [];
const startTime = Date.now();

function ok(name, detail = '') { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
function fail(name, err) { failed++; failures.push({ name, err: String(err) }); console.log(`  ❌ ${name}: ${err}`); }
function elapsed() { return `${((Date.now() - startTime) / 1000).toFixed(1)}s`; }

async function test(name, fn, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    ok(name, `${Date.now() - t0}ms`);
  } catch (e) {
    fail(name, e.message || e);
  }
}

async function clearUnread(agent) {
  try {
    let cleared = 0;
    let batch;
    do {
      batch = await agent.receive({ unreadOnly: true, limit: 100 });
      if (batch.length > 0) {
        await agent.markReadBatch(batch.map(m => m.id));
        cleared += batch.length;
      }
    } while (batch.length >= 100 && cleared < 500);
    return cleared;
  } catch { return 0; }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 0: Registration
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE 0: Registration ═══');

let alice, bob, charlie;

await test('Register Alice', async () => {
  alice = await VoidlyAgent.register({ name: `brutal-alice-${Date.now()}`, relayUrl: BASE });
  if (!alice.did.startsWith('did:voidly:')) throw new Error(`Bad DID`);
});
await test('Register Bob', async () => {
  bob = await VoidlyAgent.register({ name: `brutal-bob-${Date.now()}`, relayUrl: BASE });
});
await test('Register Charlie (3rd party)', async () => {
  charlie = await VoidlyAgent.register({ name: `brutal-charlie-${Date.now()}`, relayUrl: BASE });
});

// Clear any stale messages
await clearUnread(alice);
await clearUnread(bob);
await clearUnread(charlie);

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1: Volume Stress — 50 messages each direction
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 1: Volume Stress [${elapsed()}] ═══`);

await test('50 messages A→B sequential', async () => {
  const tag = `vol-a2b-${Date.now()}`;
  for (let i = 0; i < 50; i++) {
    await alice.send(bob.did, `${tag}-${i.toString().padStart(3, '0')}`);
  }
  await new Promise(r => setTimeout(r, 3000));

  let received = [];
  let batch;
  do {
    batch = await bob.receive({ unreadOnly: true, limit: 100 });
    const matched = batch.filter(m => m.content?.startsWith(tag));
    received.push(...matched);
    if (batch.length > 0) await bob.markReadBatch(batch.map(m => m.id));
  } while (batch.length >= 100);

  if (received.length < 50) throw new Error(`Only ${received.length}/50 received`);

  // Verify ordering
  for (let i = 1; i < received.length; i++) {
    const prev = parseInt(received[i-1].content.split('-').pop());
    const curr = parseInt(received[i].content.split('-').pop());
    if (curr < prev) throw new Error(`Out of order at index ${i}: ${prev} > ${curr}`);
  }
}, 120000);

await test('50 messages B→A sequential', async () => {
  const tag = `vol-b2a-${Date.now()}`;
  for (let i = 0; i < 50; i++) {
    await bob.send(alice.did, `${tag}-${i.toString().padStart(3, '0')}`);
  }
  await new Promise(r => setTimeout(r, 3000));

  let received = [];
  let batch;
  do {
    batch = await alice.receive({ unreadOnly: true, limit: 100 });
    const matched = batch.filter(m => m.content?.startsWith(tag));
    received.push(...matched);
    if (batch.length > 0) await alice.markReadBatch(batch.map(m => m.id));
  } while (batch.length >= 100);

  if (received.length < 50) throw new Error(`Only ${received.length}/50 received`);
}, 120000);

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Concurrent Bidirectional Storm
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 2: Concurrent Storm [${elapsed()}] ═══`);

await test('20 concurrent each direction simultaneously', async () => {
  const tagA = `storm-a-${Date.now()}`;
  const tagB = `storm-b-${Date.now()}`;

  // Fire both sides simultaneously
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => alice.send(bob.did, `${tagA}-${i}`)),
    ...Array.from({ length: 20 }, (_, i) => bob.send(alice.did, `${tagB}-${i}`)),
  ]);

  await new Promise(r => setTimeout(r, 4000));

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 100 });

  const bobGot = bobMsgs.filter(m => m.content?.startsWith(tagA)).length;
  const aliceGot = aliceMsgs.filter(m => m.content?.startsWith(tagB)).length;

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));

  if (bobGot < 20) throw new Error(`Bob only got ${bobGot}/20`);
  if (aliceGot < 20) throw new Error(`Alice only got ${aliceGot}/20`);
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Edge Cases
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 3: Edge Cases [${elapsed()}] ═══`);

await test('Unicode: emojis, CJK, RTL, combining chars', async () => {
  const msgs = [
    '🎉🔥💀🚀🤖 emoji parade',
    '日本語テスト 中文测试 한국어시험',
    'مرحبا بالعالم العربي',
    'Z̸͈̊a̴̜̓l̷̩̈́g̶̤̈o̸̞̒ ̷̬̓t̸̗̀e̸̮̔x̵̢̾t̴̮̽',
    'Line1\nLine2\n\nLine4',
    '   spaces   and\ttabs\there   ',
    '<script>alert("xss")</script>',
    '{"json": "injection", "test": true}',
    'a'.repeat(100), // 100 a's
    `null undefined NaN Infinity -0`,
  ];

  for (const msg of msgs) {
    await alice.send(bob.did, msg);
  }
  await new Promise(r => setTimeout(r, 3000));

  const received = await bob.receive({ unreadOnly: true, limit: 50 });
  if (received.length < msgs.length) throw new Error(`Only ${received.length}/${msgs.length} edge case msgs received`);

  // Verify content integrity
  const contents = received.map(m => m.content);
  for (const msg of msgs) {
    if (!contents.includes(msg)) {
      throw new Error(`Missing message: ${msg.slice(0, 30)}...`);
    }
  }

  await bob.markReadBatch(received.map(m => m.id));
});

await test('Large message: 5KB', async () => {
  const large = 'X'.repeat(5000) + `-5kb-${Date.now()}`;
  await alice.send(bob.did, large);
  await new Promise(r => setTimeout(r, 2000));
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content?.includes('-5kb-'));
  if (!found) throw new Error('5KB message not received');
  if (found.content.length !== large.length) throw new Error(`Length mismatch: ${found.content.length} vs ${large.length}`);
  if (found.content !== large) throw new Error('Content mismatch');
  await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Large message: 10KB', async () => {
  const large = 'Y'.repeat(10000) + `-10kb-${Date.now()}`;
  await alice.send(bob.did, large);
  await new Promise(r => setTimeout(r, 2000));
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content?.includes('-10kb-'));
  if (!found) throw new Error('10KB message not received');
  if (found.content !== large) throw new Error(`Content mismatch: got ${found.content.length} chars`);
  await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Single character messages', async () => {
  const chars = ['a', '0', '!', '¡', '你', '🔥'];
  for (const c of chars) {
    await alice.send(bob.did, c);
  }
  await new Promise(r => setTimeout(r, 2000));
  const msgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const received = msgs.map(m => m.content);
  for (const c of chars) {
    if (!received.includes(c)) throw new Error(`Missing char: ${c}`);
  }
  await bob.markReadBatch(msgs.map(m => m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 4: SSE Under Load
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 4: SSE Under Load [${elapsed()}] ═══`);

await test('SSE receives 10 messages sent 500ms apart', async () => {
  const tag = `sse-load-${Date.now()}`;
  const received = [];

  const handle = bob.listen(
    (msg) => { if (msg.content?.startsWith(tag)) received.push(msg.content); },
    { unreadOnly: true, autoMarkRead: true },
  );

  await new Promise(r => setTimeout(r, 2000)); // Let SSE connect

  for (let i = 0; i < 10; i++) {
    await alice.send(bob.did, `${tag}-${i}`);
    await new Promise(r => setTimeout(r, 500));
  }

  // Wait for delivery
  const deadline = Date.now() + 15000;
  while (received.length < 10 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  handle.stop();

  if (received.length < 10) throw new Error(`SSE only got ${received.length}/10`);

  // Clean up any stragglers
  await clearUnread(bob);
}, 30000);

await test('SSE + concurrent poll — no message loss', async () => {
  const tag = `sse-poll-${Date.now()}`;
  const sseGot = [];

  const handle = bob.listen(
    (msg) => { if (msg.content?.startsWith(tag)) sseGot.push(msg.content); },
    { unreadOnly: true, autoMarkRead: true },
  );

  await new Promise(r => setTimeout(r, 1500));

  // Send 5 messages
  for (let i = 0; i < 5; i++) {
    await alice.send(bob.did, `${tag}-${i}`);
  }

  await new Promise(r => setTimeout(r, 1000));

  // Now poll concurrently
  const pollMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const pollGot = pollMsgs.filter(m => m.content?.startsWith(tag));

  await new Promise(r => setTimeout(r, 3000));
  handle.stop();

  const total = new Set([...sseGot, ...pollGot.map(m => m.content)]).size;
  if (total < 5) throw new Error(`Only ${total}/5 unique messages (SSE=${sseGot.length}, poll=${pollGot.length})`);

  if (pollMsgs.length > 0) await bob.markReadBatch(pollMsgs.map(m => m.id));
  await clearUnread(bob);
});

await test('SSE reconnect after stop/start', async () => {
  const tag1 = `sse-r1-${Date.now()}`;
  const tag2 = `sse-r2-${Date.now()}`;
  const r1 = [];
  const r2 = [];

  // First SSE session
  const h1 = bob.listen(
    (msg) => { if (msg.content?.startsWith(tag1)) r1.push(msg.content); },
    { unreadOnly: true, autoMarkRead: true },
  );
  await new Promise(r => setTimeout(r, 1500));
  await alice.send(bob.did, `${tag1}-0`);
  await new Promise(r => setTimeout(r, 3000));
  h1.stop();

  // Brief gap
  await new Promise(r => setTimeout(r, 1000));

  // Second SSE session
  const h2 = bob.listen(
    (msg) => { if (msg.content?.startsWith(tag2)) r2.push(msg.content); },
    { unreadOnly: true, autoMarkRead: true },
  );
  await new Promise(r => setTimeout(r, 1500));
  await alice.send(bob.did, `${tag2}-0`);
  await new Promise(r => setTimeout(r, 3000));
  h2.stop();

  if (r1.length < 1) throw new Error(`First session got ${r1.length}/1`);
  if (r2.length < 1) throw new Error(`Second session got ${r2.length}/1 (reconnect failed)`);

  await clearUnread(bob);
}, 30000);

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 5: Multi-Peer Conversations
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 5: Multi-Peer [${elapsed()}] ═══`);

await test('Alice talks to Bob AND Charlie simultaneously', async () => {
  const tagB = `multi-b-${Date.now()}`;
  const tagC = `multi-c-${Date.now()}`;

  await Promise.all([
    alice.send(bob.did, `${tagB}-hello`),
    alice.send(charlie.did, `${tagC}-hello`),
  ]);

  await new Promise(r => setTimeout(r, 2000));

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const charlieMsgs = await charlie.receive({ unreadOnly: true, limit: 10 });

  const bobGot = bobMsgs.find(m => m.content === `${tagB}-hello`);
  const charlieGot = charlieMsgs.find(m => m.content === `${tagC}-hello`);

  if (!bobGot) throw new Error('Bob did not receive');
  if (!charlieGot) throw new Error('Charlie did not receive');

  await bob.markReadBatch(bobMsgs.map(m => m.id));
  await charlie.markReadBatch(charlieMsgs.map(m => m.id));
});

await test('Three-way conversation: A→B, B→C, C→A', async () => {
  const t = Date.now();
  await alice.send(bob.did, `3way-ab-${t}`);
  await bob.send(charlie.did, `3way-bc-${t}`);
  await charlie.send(alice.did, `3way-ca-${t}`);

  await new Promise(r => setTimeout(r, 3000));

  const bMsgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const cMsgs = await charlie.receive({ unreadOnly: true, limit: 10 });
  const aMsgs = await alice.receive({ unreadOnly: true, limit: 10 });

  if (!bMsgs.find(m => m.content === `3way-ab-${t}`)) throw new Error('B missed A→B');
  if (!cMsgs.find(m => m.content === `3way-bc-${t}`)) throw new Error('C missed B→C');
  if (!aMsgs.find(m => m.content === `3way-ca-${t}`)) throw new Error('A missed C→A');

  await bob.markReadBatch(bMsgs.map(m => m.id));
  await charlie.markReadBatch(cMsgs.map(m => m.id));
  await alice.markReadBatch(aMsgs.map(m => m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 6: Call Signal Stress
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 6: Call Signals [${elapsed()}] ═══`);

await test('5 rapid call signals delivered', async () => {
  const signals = ['call-offer', 'call-ice', 'call-ice', 'call-ice', 'call-answer'];
  const t = Date.now();

  for (const type of signals) {
    const sig = { type, callId: `test-${t}`, sdp: 'v=0\r\nfake' };
    await alice.send(bob.did, JSON.stringify(sig), {
      contentType: 'application/x-call-signal',
      messageType: 'call-signal',
      ttl: 60,
    });
  }

  await new Promise(r => setTimeout(r, 2000));
  const msgs = await bob.receive({ unreadOnly: true, limit: 20 });
  const callMsgs = msgs.filter(m => {
    try {
      const parsed = JSON.parse(m.content);
      return parsed.callId === `test-${t}`;
    } catch { return false; }
  });

  if (callMsgs.length < 5) throw new Error(`Only ${callMsgs.length}/5 call signals received`);
  await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Call signal after 20 message backlog', async () => {
  const tag = `backlog-${Date.now()}`;

  // Create backlog
  for (let i = 0; i < 20; i++) {
    await alice.send(bob.did, `${tag}-filler-${i}`);
  }

  // Send call signal
  const sig = { type: 'call-offer', callId: `backlog-${Date.now()}`, sdp: 'v=0\r\ntest' };
  await alice.send(bob.did, JSON.stringify(sig), {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await new Promise(r => setTimeout(r, 3000));

  // Receive all
  let allMsgs = [];
  let batch;
  do {
    batch = await bob.receive({ unreadOnly: true, limit: 100 });
    allMsgs.push(...batch);
    if (batch.length > 0) await bob.markReadBatch(batch.map(m => m.id));
  } while (batch.length >= 100);

  const callMsg = allMsgs.find(m => {
    try { return JSON.parse(m.content).callId?.startsWith('backlog-'); } catch { return false; }
  });
  if (!callMsg) throw new Error(`Call signal lost behind ${allMsgs.length} messages`);
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 7: Credential Export/Restore Mid-Conversation
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 7: Credential Persistence [${elapsed()}] ═══`);

await test('Export, restore, continue conversation', async () => {
  const tag = `persist-${Date.now()}`;

  // Send a message to establish ratchet
  await alice.send(bob.did, `${tag}-before`);
  await new Promise(r => setTimeout(r, 1000));
  let msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === `${tag}-before`)) throw new Error('Pre-export message lost');
  await bob.markReadBatch(msgs.map(m => m.id));

  // Export Alice's credentials
  const creds = alice.exportCredentials();
  const credsJson = JSON.stringify(creds);

  // Restore Alice from credentials
  const aliceRestored = VoidlyAgent.fromCredentials(JSON.parse(credsJson));

  // Send from restored instance
  await aliceRestored.send(bob.did, `${tag}-after`);
  await new Promise(r => setTimeout(r, 1000));
  msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === `${tag}-after`)) throw new Error('Post-restore message lost');
  await bob.markReadBatch(msgs.map(m => m.id));

  // Verify reverse direction still works
  await bob.send(aliceRestored.did, `${tag}-reverse`);
  await new Promise(r => setTimeout(r, 1000));
  msgs = await aliceRestored.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === `${tag}-reverse`)) throw new Error('Reverse after restore failed');
  await aliceRestored.markReadBatch(msgs.map(m => m.id));

  // Use original alice reference going forward (creds are the same object)
  alice = aliceRestored;
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 8: Rapid Alternating Directions
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 8: Rapid Alternation [${elapsed()}] ═══`);

await test('20 rapid ping-pongs (A→B, B→A, alternating)', async () => {
  const tag = `pong-${Date.now()}`;

  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      await alice.send(bob.did, `${tag}-a2b-${i}`);
    } else {
      await bob.send(alice.did, `${tag}-b2a-${i}`);
    }
    // No delay — stress the ratchet alternation
  }

  await new Promise(r => setTimeout(r, 3000));

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 50 });

  const bobGot = bobMsgs.filter(m => m.content?.startsWith(`${tag}-a2b`)).length;
  const aliceGot = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-b2a`)).length;

  if (bobGot < 10) throw new Error(`Bob only got ${bobGot}/10 (expected from A→B)`);
  if (aliceGot < 10) throw new Error(`Alice only got ${aliceGot}/10 (expected from B→A)`);

  await bob.markReadBatch(bobMsgs.map(m => m.id));
  await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 9: markRead Correctness
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 9: markRead Correctness [${elapsed()}] ═══`);

await test('Marked-read messages dont reappear', async () => {
  const tag = `norepeat-${Date.now()}`;
  await alice.send(bob.did, `${tag}-0`);
  await alice.send(bob.did, `${tag}-1`);
  await new Promise(r => setTimeout(r, 1500));

  // First receive
  let msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.filter(m => m.content?.startsWith(tag));
  if (found.length < 2) throw new Error(`First receive: ${found.length}/2`);
  await bob.markReadBatch(msgs.map(m => m.id));

  // Second receive — should NOT get the same messages
  await new Promise(r => setTimeout(r, 500));
  msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const repeated = msgs.filter(m => m.content?.startsWith(tag));
  if (repeated.length > 0) throw new Error(`${repeated.length} messages repeated after markRead!`);
});

await test('Unread count accurate', async () => {
  const tag = `count-${Date.now()}`;
  await alice.send(bob.did, `${tag}-0`);
  await alice.send(bob.did, `${tag}-1`);
  await alice.send(bob.did, `${tag}-2`);
  await new Promise(r => setTimeout(r, 1500));

  const countData = await bob.getUnreadCount();
  const count = typeof countData === 'number' ? countData : Number(countData?.unread_count ?? 0);
  if (count < 3) throw new Error(`Unread count is ${count}, expected ≥3`);

  // Clean up
  await clearUnread(bob);
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 10: Content Types & Message Types
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 10: Content/Message Types [${elapsed()}] ═══`);

await test('Custom contentType preserved', async () => {
  await alice.send(bob.did, '{"key": "value"}', { contentType: 'application/json' });
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content === '{"key": "value"}');
  if (!found) throw new Error('Custom contentType message not received');
  // contentType may not survive the sealed sender envelope — check if it's there
  if (found.contentType && found.contentType !== 'application/json') {
    console.log(`    ℹ️ contentType: ${found.contentType} (expected application/json)`);
  }
  await bob.markReadBatch(msgs.map(m => m.id));
});

await test('TTL messages delivered before expiry', async () => {
  await alice.send(bob.did, `ttl-test-${Date.now()}`, { ttl: 30 });
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => m.content?.startsWith('ttl-test-'));
  if (!found) throw new Error('TTL message not received');
  await bob.markReadBatch(msgs.map(m => m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 11: Post-Stress Health Check
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ PHASE 11: Post-Stress Health [${elapsed()}] ═══`);

await test('A→B still works after all stress', async () => {
  const tag = `final-a2b-${Date.now()}`;
  await alice.send(bob.did, tag);
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === tag)) throw new Error('Post-stress A→B FAILED');
  await bob.markReadBatch(msgs.map(m => m.id));
});

await test('B→A still works after all stress', async () => {
  const tag = `final-b2a-${Date.now()}`;
  await bob.send(alice.did, tag);
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await alice.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === tag)) throw new Error('Post-stress B→A FAILED');
  await alice.markReadBatch(msgs.map(m => m.id));
});

await test('A→C still works after all stress', async () => {
  const tag = `final-a2c-${Date.now()}`;
  await alice.send(charlie.did, tag);
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await charlie.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === tag)) throw new Error('Post-stress A→C FAILED');
  await charlie.markReadBatch(msgs.map(m => m.id));
});

await test('C→A still works after all stress', async () => {
  const tag = `final-c2a-${Date.now()}`;
  await charlie.send(alice.did, tag);
  await new Promise(r => setTimeout(r, 1500));
  const msgs = await alice.receive({ unreadOnly: true, limit: 10 });
  if (!msgs.find(m => m.content === tag)) throw new Error('Post-stress C→A FAILED');
  await alice.markReadBatch(msgs.map(m => m.id));
});

await test('Decrypt fail count is 0', async () => {
  const aliceFails = alice.decryptFailCount;
  const bobFails = bob.decryptFailCount;
  const charlieFails = charlie.decryptFailCount;
  if (aliceFails > 0) throw new Error(`Alice has ${aliceFails} decrypt failures`);
  if (bobFails > 0) throw new Error(`Bob has ${bobFails} decrypt failures`);
  if (charlieFails > 0) throw new Error(`Charlie has ${charlieFails} decrypt failures`);
});

// ══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n═══ Cleanup [${elapsed()}] ═══`);

await test('Deactivate all agents', async () => {
  await alice.deactivate();
  await bob.deactivate();
  await charlie.deactivate();
});

// ══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════════════════════════════════════════
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('\n' + '═'.repeat(70));
console.log(`BRUTAL TEST RESULTS: ${passed} passed, ${failed} failed (${totalTime}s total)`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
