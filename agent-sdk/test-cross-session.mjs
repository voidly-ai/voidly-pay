/**
 * Round 13: Cross-Session Ratchet Persistence Test
 *
 * Simulates the real-world scenario:
 * 1. Register two agents, establish ratchet
 * 2. Export credentials (simulate "close app")
 * 3. Create new agent instances from credentials (simulate "reopen app")
 * 4. Verify messaging still works in both directions
 * 5. Repeat multiple times to simulate many app restarts
 * 6. Verify call signals work after restart
 * 7. Test "one side restarts, other doesn't" scenario
 * 8. Test both sides restart simultaneously
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

async function sendAndVerify(sender, receiver, content, waitMs = 1500) {
  await sender.send(receiver.did, content);
  await sleep(waitMs);
  const msgs = await receiver.receive({ unreadOnly: true, limit: 50 });
  const found = msgs.find(m => m.content === content);
  if (msgs.length > 0) await receiver.markReadBatch(msgs.map(m => m.id));
  if (!found) throw new Error(`"${content.slice(0, 40)}" not found in ${msgs.length} msgs`);
  return found;
}

// Simulate app restart: export creds, destroy instance, restore from creds
async function restart(agent) {
  const creds = agent.exportCredentials();
  agent.stopAll?.();
  return VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('  ROUND 13: CROSS-SESSION RATCHET PERSISTENCE');
console.log('═'.repeat(70));

const suffix = Date.now().toString(36);
let alice, bob;

// Store credentials for independent restarts
let aliceCreds, bobCreds;

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup ═══');

await test('Register and establish ratchet', async () => {
  alice = await VoidlyAgent.register({ name: `session-alice-${suffix}`, relayUrl: BASE });
  bob = await VoidlyAgent.register({ name: `session-bob-${suffix}`, relayUrl: BASE });
  await drain(alice); await drain(bob);

  // Establish ratchet with round-trips
  await sendAndVerify(alice, bob, 'init-a2b');
  await sendAndVerify(bob, alice, 'init-b2a');
  await sendAndVerify(alice, bob, 'init-a2b-2');
  await sendAndVerify(bob, alice, 'init-b2a-2');
});

// ── T1: Single side restart ─────────────────────────────────────────────────
console.log('\n═══ T1: Alice Restarts (Bob Stays) ═══');

await test('Alice restarts, messages work both directions', async () => {
  alice = await restart(alice);
  console.log('    🔄 Alice restarted');

  // Alice → Bob should work (Alice has persisted send state)
  await sendAndVerify(alice, bob, 'post-restart-a2b-1');

  // Bob → Alice should work (Alice has persisted receive state)
  await sendAndVerify(bob, alice, 'post-restart-b2a-1');
});

// ── T2: Other side restarts ─────────────────────────────────────────────────
console.log('\n═══ T2: Bob Restarts (Alice Stays) ═══');

await test('Bob restarts, messages work both directions', async () => {
  bob = await restart(bob);
  console.log('    🔄 Bob restarted');

  await sendAndVerify(alice, bob, 'bob-restart-a2b');
  await sendAndVerify(bob, alice, 'bob-restart-b2a');
});

// ── T3: Both restart simultaneously ─────────────────────────────────────────
console.log('\n═══ T3: Both Restart Simultaneously ═══');

await test('Both restart from credentials, continue messaging', async () => {
  aliceCreds = alice.exportCredentials();
  bobCreds = bob.exportCredentials();

  alice.stopAll?.();
  bob.stopAll?.();

  // Simulate both apps restarting
  alice = await VoidlyAgent.fromCredentialsAsync(aliceCreds, { baseUrl: BASE });
  bob = await VoidlyAgent.fromCredentialsAsync(bobCreds, { baseUrl: BASE });
  console.log('    🔄 Both restarted');

  await sendAndVerify(alice, bob, 'both-restart-a2b');
  await sendAndVerify(bob, alice, 'both-restart-b2a');
});

// ── T4: Multiple restart cycles ─────────────────────────────────────────────
console.log('\n═══ T4: Multiple Restart Cycles ═══');

await test('5 restart cycles with messaging between each', async () => {
  for (let cycle = 0; cycle < 5; cycle++) {
    // Send messages
    await sendAndVerify(alice, bob, `cycle-${cycle}-a2b`);
    await sendAndVerify(bob, alice, `cycle-${cycle}-b2a`);

    // Restart one side (alternate)
    if (cycle % 2 === 0) {
      alice = await restart(alice);
      console.log(`    🔄 Cycle ${cycle}: Alice restarted`);
    } else {
      bob = await restart(bob);
      console.log(`    🔄 Cycle ${cycle}: Bob restarted`);
    }
  }

  // Final verification after 5 cycles
  await sendAndVerify(alice, bob, 'after-5-cycles-a2b');
  await sendAndVerify(bob, alice, 'after-5-cycles-b2a');
});

// ── T5: Messages sent DURING restart ────────────────────────────────────────
console.log('\n═══ T5: Messages Sent During Restart ═══');

await test('Bob sends while Alice restarts, Alice receives after restart', async () => {
  // Save Alice creds
  aliceCreds = alice.exportCredentials();

  // Bob sends while Alice is "restarting"
  const tag = `during-restart-${Date.now()}`;
  await bob.send(alice.did, `${tag}-1`);
  await bob.send(alice.did, `${tag}-2`);
  await bob.send(alice.did, `${tag}-3`);

  await sleep(1000);

  // Alice "reopens" the app
  alice = await VoidlyAgent.fromCredentialsAsync(aliceCreds, { baseUrl: BASE });
  console.log('    🔄 Alice restarted after messages sent');

  await sleep(1500);
  const msgs = await alice.receive({ unreadOnly: true, limit: 50 });
  const found = msgs.filter(m => m.content?.startsWith(tag));
  console.log(`    📥 Alice received ${found.length}/3 messages sent during restart`);

  if (found.length < 3) throw new Error(`Only ${found.length}/3 messages from during restart`);
  if (msgs.length > 0) await alice.markReadBatch(msgs.map(m => m.id));
});

// ── T6: Call signal after restart ───────────────────────────────────────────
console.log('\n═══ T6: Call Signal After Restart ═══');

await test('Call signal works after both sides restart', async () => {
  // Both restart
  alice = await restart(alice);
  bob = await restart(bob);
  console.log('    🔄 Both restarted');

  const callId = `restart-call-${Date.now()}`;
  const signal = JSON.stringify({
    type: 'call-offer',
    callId,
    sdp: 'v=0\r\ntest',
    video: false,
  });

  await alice.send(bob.did, signal, {
    contentType: 'application/x-call-signal',
    messageType: 'call-signal',
    ttl: 60,
  });

  await sleep(1500);
  const msgs = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = msgs.find(m => {
    try { return JSON.parse(m.content).callId === callId; } catch { return false; }
  });
  if (!found) throw new Error('Call signal not received after restart');
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T7: Heavy use after restart ─────────────────────────────────────────────
console.log('\n═══ T7: Heavy Use After Restart ═══');

await test('20 rapid messages after both restart', async () => {
  alice = await restart(alice);
  bob = await restart(bob);
  console.log('    🔄 Both restarted');

  const tag = `heavy-restart-${Date.now()}`;

  // 10 each direction, concurrent
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => alice.send(bob.did, `${tag}-a2b-${i}`)),
    ...Array.from({ length: 10 }, (_, i) => bob.send(alice.did, `${tag}-b2a-${i}`)),
  ]);

  await sleep(3000);

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 100 });

  const bobGot = bobMsgs.filter(m => m.content?.startsWith(`${tag}-a2b`)).length;
  const aliceGot = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-b2a`)).length;

  console.log(`    📥 Bob: ${bobGot}/10, Alice: ${aliceGot}/10`);
  if (bobGot < 10) throw new Error(`Bob only got ${bobGot}/10`);
  if (aliceGot < 10) throw new Error(`Alice only got ${aliceGot}/10`);

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ── T8: Final health ────────────────────────────────────────────────────────
console.log('\n═══ T8: Final Health Check ═══');

await test('Ratchet healthy after all session tests', async () => {
  const tag = `final-session-${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    await sendAndVerify(alice, bob, `${tag}-a2b-${i}`);
    await sendAndVerify(bob, alice, `${tag}-b2a-${i}`);
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');

await test('Deactivate', async () => {
  await alice.deactivate().catch(() => {});
  await bob.deactivate().catch(() => {});
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  ROUND 13 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
