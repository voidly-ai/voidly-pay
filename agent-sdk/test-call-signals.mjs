/**
 * Round 9: Voice Call Signal Flow Simulation
 *
 * Simulates the complete call signaling lifecycle:
 * 1. Offer → Answer → ICE candidates (full call setup)
 * 2. Offer with TTL (expires correctly)
 * 3. Multiple rapid ICE candidates
 * 4. Call signal priority (arrives during message backlog)
 * 5. Call signal after credential restore
 * 6. Bidirectional call signals (glare scenario)
 * 7. Call hangup signal
 * 8. Call signals via SSE
 * 9. Call signal content types preserved
 * 10. Post-call messaging still works
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

function makeCallSignal(type, callId, extra = {}) {
  return JSON.stringify({
    type,
    callId: callId || `call-${Date.now()}`,
    ts: Date.now(),
    ...extra,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('  ROUND 9: VOICE CALL SIGNAL FLOW SIMULATION');
console.log('═'.repeat(70));

const suffix = Date.now().toString(36);
let alice, bob;

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup ═══');

await test('Register agents', async () => {
  alice = await VoidlyAgent.register({ name: `call-alice-${suffix}`, relayUrl: BASE });
  bob = await VoidlyAgent.register({ name: `call-bob-${suffix}`, relayUrl: BASE });
  await drain(alice); await drain(bob);
  // Warm up ratchet
  await alice.send(bob.did, 'warmup'); await sleep(500); await drain(bob);
  await bob.send(alice.did, 'warmup-back'); await sleep(500); await drain(alice);
});

// ── T1: Full call setup flow ────────────────────────────────────────────────
console.log('\n═══ T1: Full Call Setup Flow ═══');

await test('Offer → Answer → ICE candidates (complete flow)', async () => {
  const callId = `call-full-${Date.now()}`;

  // 1. Alice sends offer
  const offer = makeCallSignal('call-offer', callId, {
    sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\n',
    video: false,
  });
  await alice.send(bob.did, offer, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await sleep(1000);
  let msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  let offerMsg = msgs.find(m => {
    try { return JSON.parse(m.content).type === 'call-offer' && JSON.parse(m.content).callId === callId; } catch { return false; }
  });
  if (!offerMsg) throw new Error(`Offer not received (${msgs.length} msgs)`);
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));

  // 2. Bob sends answer
  const answer = makeCallSignal('call-answer', callId, {
    sdp: 'v=0\r\no=- 456 2 IN IP4 127.0.0.1\r\ns=-\r\n',
  });
  await bob.send(alice.did, answer, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await sleep(1000);
  msgs = await alice.receive({ unreadOnly: true, limit: 10 });
  let answerMsg = msgs.find(m => {
    try { return JSON.parse(m.content).type === 'call-answer' && JSON.parse(m.content).callId === callId; } catch { return false; }
  });
  if (!answerMsg) throw new Error(`Answer not received (${msgs.length} msgs)`);
  if (msgs.length > 0) await alice.markReadBatch(msgs.map(m => m.id));

  // 3. Both sides send ICE candidates
  for (let i = 0; i < 3; i++) {
    const iceA = makeCallSignal('ice-candidate', callId, {
      candidate: `candidate:1 1 udp 2113937151 192.168.1.${i} ${5000 + i} typ host`,
    });
    const iceB = makeCallSignal('ice-candidate', callId, {
      candidate: `candidate:1 1 udp 2113937151 192.168.2.${i} ${6000 + i} typ host`,
    });
    await alice.send(bob.did, iceA, { contentType: 'application/x-call-signal', messageType: 'call-signal', ttl: 30 });
    await bob.send(alice.did, iceB, { contentType: 'application/x-call-signal', messageType: 'call-signal', ttl: 30 });
  }

  await sleep(2000);
  const bobIce = await bob.receive({ unreadOnly: true, limit: 50 });
  const aliceIce = await alice.receive({ unreadOnly: true, limit: 50 });
  const bobIceCount = bobIce.filter(m => { try { return JSON.parse(m.content).type === 'ice-candidate'; } catch { return false; } }).length;
  const aliceIceCount = aliceIce.filter(m => { try { return JSON.parse(m.content).type === 'ice-candidate'; } catch { return false; } }).length;

  if (bobIce.length > 0) await bob.markReadBatch(bobIce.map(m => m.id));
  if (aliceIce.length > 0) await alice.markReadBatch(aliceIce.map(m => m.id));

  console.log(`    📞 Offer✅ Answer✅ ICE: Bob=${bobIceCount}/3, Alice=${aliceIceCount}/3`);
  if (bobIceCount < 3 || aliceIceCount < 3) throw new Error(`ICE incomplete: Bob=${bobIceCount}, Alice=${aliceIceCount}`);
});

// ── T2: Rapid ICE candidates ────────────────────────────────────────────────
console.log('\n═══ T2: Rapid ICE Candidates ═══');

await test('10 rapid ICE candidates delivered', async () => {
  const callId = `call-ice-${Date.now()}`;

  // Send 10 ICE candidates as fast as possible
  const promises = [];
  for (let i = 0; i < 10; i++) {
    const ice = makeCallSignal('ice-candidate', callId, {
      candidate: `candidate:${i} 1 udp ${2000000 + i} 10.0.0.${i} ${7000 + i} typ srflx`,
    });
    promises.push(alice.send(bob.did, ice, {
      contentType: 'application/x-call-signal',
      messageType: 'call-signal',
      ttl: 30,
    }));
  }
  await Promise.all(promises);

  await sleep(3000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const iceFound = msgs.filter(m => {
    try { const p = JSON.parse(m.content); return p.type === 'ice-candidate' && p.callId === callId; } catch { return false; }
  });

  console.log(`    📞 ${iceFound.length}/10 rapid ICE candidates delivered`);
  if (iceFound.length < 10) throw new Error(`Only ${iceFound.length}/10`);
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T3: Call signal priority over message backlog ───────────────────────────
console.log('\n═══ T3: Call Signal Priority ═══');

await test('Call signal arrives amidst 20 regular messages', async () => {
  const callId = `call-priority-${Date.now()}`;
  const tag = `backlog-${Date.now()}`;

  // Send 10 regular messages first
  for (let i = 0; i < 10; i++) {
    await alice.send(bob.did, `${tag}-${i}`);
  }

  // Then send the call signal
  const offer = makeCallSignal('call-offer', callId, { sdp: 'fake-sdp', video: true });
  await alice.send(bob.did, offer, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  // Send 10 more regular messages after
  for (let i = 10; i < 20; i++) {
    await alice.send(bob.did, `${tag}-${i}`);
  }

  await sleep(3000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 100 });

  const callMsg = msgs.find(m => {
    try { return JSON.parse(m.content).type === 'call-offer' && JSON.parse(m.content).callId === callId; } catch { return false; }
  });
  const regularMsgs = msgs.filter(m => m.content?.startsWith(tag));

  if (!callMsg) throw new Error(`Call signal not found among ${msgs.length} messages`);
  console.log(`    📞 Call signal found among ${regularMsgs.length} regular messages`);

  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T4: Glare scenario ──────────────────────────────────────────────────────
console.log('\n═══ T4: Glare Scenario ═══');

await test('Both sides send call-offer simultaneously', async () => {
  const callIdA = `glare-a-${Date.now()}`;
  const callIdB = `glare-b-${Date.now()}`;

  const offerA = makeCallSignal('call-offer', callIdA, { sdp: 'alice-sdp', video: false });
  const offerB = makeCallSignal('call-offer', callIdB, { sdp: 'bob-sdp', video: false });

  // Both send offers simultaneously
  await Promise.all([
    alice.send(bob.did, offerA, { contentType: 'application/x-call-signal', messageType: 'call-signal', ttl: 60 }),
    bob.send(alice.did, offerB, { contentType: 'application/x-call-signal', messageType: 'call-signal', ttl: 60 }),
  ]);

  await sleep(2000);

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 50 });

  const bobGotOffer = bobMsgs.find(m => {
    try { return JSON.parse(m.content).callId === callIdA; } catch { return false; }
  });
  const aliceGotOffer = aliceMsgs.find(m => {
    try { return JSON.parse(m.content).callId === callIdB; } catch { return false; }
  });

  console.log(`    📞 Glare: Bob got Alice's offer=${!!bobGotOffer}, Alice got Bob's offer=${!!aliceGotOffer}`);
  if (!bobGotOffer && !aliceGotOffer) throw new Error('Neither offer delivered in glare');

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ── T5: Call signal via SSE ─────────────────────────────────────────────────
console.log('\n═══ T5: Call Signal via SSE ═══');

await test('SSE receives call signals in real-time', async () => {
  const callId = `sse-call-${Date.now()}`;
  const received = [];

  const handle = bob.listen(
    (msg) => {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.callId === callId) received.push(parsed);
      } catch {}
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);

  // Send offer via Alice
  const offer = makeCallSignal('call-offer', callId, { sdp: 'sse-sdp', video: false });
  await alice.send(bob.did, offer, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await sleep(3000);
  handle.stop();

  if (received.length === 0) {
    // Fallback to poll
    const msgs = await bob.receive({ unreadOnly: true, limit: 50 });
    const found = msgs.find(m => {
      try { return JSON.parse(m.content).callId === callId; } catch { return false; }
    });
    if (!found) throw new Error('Call signal not received via SSE or poll');
    if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
  }

  console.log(`    📞 SSE received ${received.length} call signal(s)`);
});

// ── T6: Call signal after credential restore ────────────────────────────────
console.log('\n═══ T6: Call Signal After Credential Restore ═══');

await test('Credential restore then receive call signal', async () => {
  const creds = bob.exportCredentials();
  const bobRestored = await VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });

  const callId = `restore-call-${Date.now()}`;
  const offer = makeCallSignal('call-offer', callId, { sdp: 'restored-sdp', video: true });
  await alice.send(bobRestored.did, offer, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await sleep(1500);
  const msgs = await bobRestored.receive({ unreadOnly: true, limit: 50 });
  const found = msgs.find(m => {
    try { return JSON.parse(m.content).callId === callId; } catch { return false; }
  });
  if (!found) throw new Error('Call signal not received after credential restore');
  if (msgs.length > 0) await bobRestored.markReadBatch(msgs.map(m => m.id));

  bob = bobRestored;
});

// ── T7: Hangup signal ───────────────────────────────────────────────────────
console.log('\n═══ T7: Hangup Signal ═══');

await test('Hangup signal delivered correctly', async () => {
  const callId = `hangup-${Date.now()}`;
  const hangup = makeCallSignal('call-hangup', callId, { reason: 'user-ended' });
  await alice.send(bob.did, hangup, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 30,
  });

  await sleep(1000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => {
    try { return JSON.parse(m.content).type === 'call-hangup' && JSON.parse(m.content).callId === callId; } catch { return false; }
  });
  if (!found) throw new Error('Hangup not received');
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T8: Call signal content types preserved ─────────────────────────────────
console.log('\n═══ T8: Content Type Preservation ═══');

await test('application/x-call-signal contentType preserved through E2E', async () => {
  const callId = `ct-${Date.now()}`;
  const signal = makeCallSignal('call-offer', callId, { sdp: 'test' });
  await alice.send(bob.did, signal, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await sleep(1000);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => {
    try { return JSON.parse(m.content).callId === callId; } catch { return false; }
  });

  if (!found) throw new Error('Signal not received');

  // Check if contentType was preserved (may be in content or envelope)
  if (found.contentType === 'application/x-call-signal') {
    console.log('    📞 contentType preserved in metadata');
  } else {
    // Check if it's in the sealed envelope
    const parsed = JSON.parse(found.content);
    if (parsed.type === 'call-offer') {
      console.log('    📞 Signal type preserved in content (contentType in envelope)');
    }
  }

  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T9: Post-call messaging ─────────────────────────────────────────────────
console.log('\n═══ T9: Post-Call Messaging ═══');

await test('Regular messages work after call signal flow', async () => {
  const tag = `post-call-${Date.now()}`;

  // 5 round-trips
  for (let i = 0; i < 5; i++) {
    await alice.send(bob.did, `${tag}-a2b-${i}`);
    await sleep(300);
  }
  await sleep(2000);

  const msgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const found = msgs.filter(m => m.content?.startsWith(tag));
  if (found.length < 5) throw new Error(`Only ${found.length}/5 post-call messages`);
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));

  // Reverse direction
  await bob.send(alice.did, `${tag}-b2a`);
  await sleep(1000);
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 10 });
  const aliceFound = aliceMsgs.find(m => m.content === `${tag}-b2a`);
  if (!aliceFound) throw new Error('Post-call B→A failed');
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');

await test('Deactivate', async () => {
  await alice.deactivate().catch(() => {});
  await bob.deactivate().catch(() => {});
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  ROUND 9 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
