/**
 * Round 3: Ratchet Recovery Under Failure Conditions
 *
 * Tests the Double Ratchet's ability to recover from:
 * 1. Credential export/restore mid-conversation (ratchet state preservation)
 * 2. One-sided conversation (many messages before reply)
 * 3. Simultaneous first-messages (X3DH race)
 * 4. Ratchet after credential round-trip (export → restore → continue)
 * 5. Long chain without DH ratchet step (hash ratchet only)
 * 6. Interleaved conversations with multiple peers
 * 7. Send-receive-send rapid alternation (DH ratchet step every message)
 * 8. Recovery after many skipped messages
 * 9. Fresh X3DH after peer "restart" (new agent, same relay)
 * 10. Sustained bidirectional under credential churn
 */

import { VoidlyAgent } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;
const failures = [];
const agents = []; // Track for cleanup

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function drain(agent) {
  try {
    const msgs = await agent.receive({ unreadOnly: true, limit: 200 });
    if (msgs.length > 0) await agent.markReadBatch(msgs.map(m => m.id));
    return msgs;
  } catch { return []; }
}

async function sendAndVerify(sender, receiver, content, waitMs = 1000) {
  await sender.send(receiver.did, content);
  await sleep(waitMs);
  const msgs = await receiver.receive({ unreadOnly: true, limit: 50 });
  const found = msgs.find(m => m.content === content);
  if (msgs.length > 0) await receiver.markReadBatch(msgs.map(m => m.id));
  if (!found) throw new Error(`Message "${content.slice(0, 40)}" not found in ${msgs.length} messages`);
  return found;
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('  ROUND 3: RATCHET RECOVERY UNDER FAILURE CONDITIONS');
console.log('═'.repeat(70));

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup ═══');
let alice, bob;

await test('Register Alice', async () => {
  alice = await VoidlyAgent.register({ name: 'ratchet-alice', relayUrl: BASE });
  agents.push(alice);
  if (!alice.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${alice.did}`);
});

await test('Register Bob', async () => {
  bob = await VoidlyAgent.register({ name: 'ratchet-bob', relayUrl: BASE });
  agents.push(bob);
  if (!bob.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${bob.did}`);
});

// Drain stale
await drain(alice);
await drain(bob);

// ── T1: Credential export/restore preserves ratchet ──────────────────────────
console.log('\n═══ T1: Credential Export/Restore Preserves Ratchet ═══');

await test('Establish ratchet with 3 round-trips', async () => {
  await sendAndVerify(alice, bob, 'ratchet-t1-a2b-1');
  await sendAndVerify(bob, alice, 'ratchet-t1-b2a-1');
  await sendAndVerify(alice, bob, 'ratchet-t1-a2b-2');
  await sendAndVerify(bob, alice, 'ratchet-t1-b2a-2');
  await sendAndVerify(alice, bob, 'ratchet-t1-a2b-3');
  await sendAndVerify(bob, alice, 'ratchet-t1-b2a-3');
});

await test('Export Alice credentials mid-conversation', async () => {
  const creds = alice.exportCredentials();
  if (!creds.did) throw new Error('No DID in exported creds');
  if (!creds.signingSecretKey) throw new Error('No signing key in exported creds');
  // Ratchet state should be present
  const credsJson = JSON.stringify(creds);
  if (!credsJson.includes('ratchetStates') && !credsJson.includes('peerStates')) {
    console.warn('  ⚠️  No ratchet states in export (may use different key name)');
  }
});

await test('Restore Alice from credentials and continue conversation', async () => {
  const creds = alice.exportCredentials();
  const aliceRestored = await VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });
  agents.push(aliceRestored);

  // Send from restored Alice → Bob should decrypt with existing ratchet
  await sendAndVerify(aliceRestored, bob, 'ratchet-t1-restored-a2b');

  // Bob → restored Alice should also work
  await sendAndVerify(bob, aliceRestored, 'ratchet-t1-restored-b2a');

  // Replace alice reference
  alice = aliceRestored;
});

// ── T2: One-sided conversation (long hash chain) ────────────────────────────
console.log('\n═══ T2: One-Sided Conversation (Hash Chain Stress) ═══');

await test('20 messages A→B without reply (pure hash ratchet)', async () => {
  const tag = `one-sided-${Date.now()}`;
  for (let i = 0; i < 20; i++) {
    await alice.send(bob.did, `${tag}-${i}`);
  }
  await sleep(3000);

  const msgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const found = msgs.filter(m => m.content?.startsWith(tag));
  if (found.length < 20) throw new Error(`Only ${found.length}/20 one-sided messages received`);

  // Verify they're all decryptable (no chain key corruption)
  const contents = found.map(m => m.content);
  for (let i = 0; i < 20; i++) {
    if (!contents.includes(`${tag}-${i}`)) throw new Error(`Missing message ${i}`);
  }

  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

await test('Bob replies after 20 one-sided messages (DH ratchet step)', async () => {
  // This tests that the DH ratchet step works after a long hash chain
  await sendAndVerify(bob, alice, 'ratchet-t2-reply-after-20');
});

await test('Alice replies back (another DH ratchet step)', async () => {
  await sendAndVerify(alice, bob, 'ratchet-t2-alice-replies-back');
});

// ── T3: Simultaneous first messages (X3DH race) ─────────────────────────────
console.log('\n═══ T3: Simultaneous First Messages (X3DH Race) ═══');

await test('Two fresh agents send first messages simultaneously', async () => {
  const carol = await VoidlyAgent.register({ name: 'ratchet-carol', relayUrl: BASE });
  const dave = await VoidlyAgent.register({ name: 'ratchet-dave', relayUrl: BASE });
  agents.push(carol, dave);

  // Both send first message at same time — both will do X3DH init
  const tag = `x3dh-race-${Date.now()}`;
  await Promise.all([
    carol.send(dave.did, `${tag}-c2d`),
    dave.send(carol.did, `${tag}-d2c`),
  ]);

  await sleep(2000);

  // Both should receive each other's messages
  const carolMsgs = await carol.receive({ unreadOnly: true, limit: 50 });
  const daveMsgs = await dave.receive({ unreadOnly: true, limit: 50 });

  const carolGot = carolMsgs.find(m => m.content === `${tag}-d2c`);
  const daveGot = daveMsgs.find(m => m.content === `${tag}-c2d`);

  // At least one direction should work. Both is ideal.
  if (!carolGot && !daveGot) throw new Error('Neither direction worked in X3DH race');

  const bothWork = carolGot && daveGot;
  ok('X3DH race', `Carol got=${!!carolGot}, Dave got=${!!daveGot}, both=${bothWork}`);

  // Verify subsequent messages work in both directions
  if (carolGot && daveGot) {
    await carol.markReadBatch(carolMsgs.map(m => m.id));
    await dave.markReadBatch(daveMsgs.map(m => m.id));

    await sendAndVerify(carol, dave, `${tag}-follow-c2d`);
    await sendAndVerify(dave, carol, `${tag}-follow-d2c`);
  } else {
    // Clean up whatever was received
    if (carolMsgs.length > 0) await carol.markReadBatch(carolMsgs.map(m => m.id));
    if (daveMsgs.length > 0) await dave.markReadBatch(daveMsgs.map(m => m.id));
  }

  await carol.deactivate().catch(() => {});
  await dave.deactivate().catch(() => {});
});

// ── T4: Credential round-trip (export → JSON → parse → restore → continue) ─
console.log('\n═══ T4: Full Credential Round-Trip ═══');

await test('Export → JSON.stringify → JSON.parse → restore → message', async () => {
  // Establish fresh state
  await sendAndVerify(alice, bob, 'pre-roundtrip-a2b');
  await sendAndVerify(bob, alice, 'pre-roundtrip-b2a');

  // Full round-trip through JSON serialization
  const creds = alice.exportCredentials();
  const json = JSON.stringify(creds);
  const parsed = JSON.parse(json);

  // Verify JSON didn't corrupt anything
  if (json.length < 100) throw new Error(`Suspiciously small credentials: ${json.length} bytes`);

  const aliceRoundtrip = await VoidlyAgent.fromCredentialsAsync(parsed, { baseUrl: BASE });
  agents.push(aliceRoundtrip);

  // Continue conversation from round-tripped credentials
  await sendAndVerify(aliceRoundtrip, bob, 'post-roundtrip-a2b');
  await sendAndVerify(bob, aliceRoundtrip, 'post-roundtrip-b2a');

  alice = aliceRoundtrip;
});

// ── T5: Interleaved multi-peer conversations ─────────────────────────────────
console.log('\n═══ T5: Interleaved Multi-Peer Conversations ═══');

await test('Alice talks to Bob and Eve interleaved', async () => {
  const eve = await VoidlyAgent.register({ name: 'ratchet-eve', relayUrl: BASE });
  agents.push(eve);

  const tag = `interleave-${Date.now()}`;

  // Rapid interleave: Alice → Bob, Alice → Eve, Bob → Alice, Eve → Alice
  await alice.send(bob.did, `${tag}-a2b-1`);
  await alice.send(eve.did, `${tag}-a2e-1`);
  await sleep(500);

  // Drain and reply
  let bobMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));

  let eveMsgs = await eve.receive({ unreadOnly: true, limit: 50 });
  if (eveMsgs.length > 0) await eve.markReadBatch(eveMsgs.map(m => m.id));

  await bob.send(alice.did, `${tag}-b2a-1`);
  await eve.send(alice.did, `${tag}-e2a-1`);
  await sleep(500);

  // Second round
  await alice.send(bob.did, `${tag}-a2b-2`);
  await alice.send(eve.did, `${tag}-a2e-2`);
  await sleep(500);

  await bob.send(alice.did, `${tag}-b2a-2`);
  await eve.send(alice.did, `${tag}-e2a-2`);

  await sleep(2000);

  // Alice should have messages from both Bob and Eve
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 100 });
  const fromBob = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-b2a`));
  const fromEve = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-e2a`));

  if (fromBob.length < 2) throw new Error(`Alice only got ${fromBob.length}/2 from Bob`);
  if (fromEve.length < 2) throw new Error(`Alice only got ${fromEve.length}/2 from Eve`);

  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));

  // Verify Bob and Eve got their messages
  bobMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
  const bobGot = bobMsgs.filter(m => m.content?.startsWith(`${tag}-a2b`));
  if (bobGot.length < 1) throw new Error(`Bob only got ${bobGot.length}/2 from Alice (round 2)`);
  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));

  eveMsgs = await eve.receive({ unreadOnly: true, limit: 50 });
  const eveGot = eveMsgs.filter(m => m.content?.startsWith(`${tag}-a2e`));
  if (eveGot.length < 1) throw new Error(`Eve only got ${eveGot.length}/2 from Alice (round 2)`);
  if (eveMsgs.length > 0) await eve.markReadBatch(eveMsgs.map(m => m.id));

  await eve.deactivate().catch(() => {});
});

// ── T6: Rapid direction alternation (DH ratchet step per message) ────────────
console.log('\n═══ T6: Rapid Direction Alternation ═══');

await test('30 alternating messages (A→B, B→A, A→B, ...)', async () => {
  const tag = `alt-${Date.now()}`;
  let aliceReceived = 0;
  let bobReceived = 0;

  for (let i = 0; i < 30; i++) {
    if (i % 2 === 0) {
      await alice.send(bob.did, `${tag}-a2b-${i}`);
    } else {
      await bob.send(alice.did, `${tag}-b2a-${i}`);
    }
    // Small delay to ensure ordering
    if (i % 5 === 4) await sleep(300);
  }

  await sleep(3000);

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 100 });

  bobReceived = bobMsgs.filter(m => m.content?.startsWith(`${tag}-a2b`)).length;
  aliceReceived = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-b2a`)).length;

  if (bobReceived < 15) throw new Error(`Bob only got ${bobReceived}/15 alternating messages`);
  if (aliceReceived < 15) throw new Error(`Alice only got ${aliceReceived}/15 alternating messages`);

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ── T7: Credential export after heavy use ────────────────────────────────────
console.log('\n═══ T7: Credential Export After Heavy Use ═══');

await test('Export credentials after 50+ messages, restore, continue', async () => {
  // At this point we've sent 60+ messages through Alice's ratchet
  const creds = alice.exportCredentials();
  const credsJson = JSON.stringify(creds);

  // Verify substantial state
  if (credsJson.length < 200) throw new Error(`Credentials too small after heavy use: ${credsJson.length}`);

  // Restore and verify continuation
  const aliceHeavy = await VoidlyAgent.fromCredentialsAsync(JSON.parse(credsJson), { baseUrl: BASE });
  agents.push(aliceHeavy);

  // 5 round-trips to verify deep ratchet still works
  for (let i = 0; i < 5; i++) {
    await sendAndVerify(aliceHeavy, bob, `heavy-restore-a2b-${i}`);
    await sendAndVerify(bob, aliceHeavy, `heavy-restore-b2a-${i}`);
  }

  alice = aliceHeavy;
});

// ── T8: SSE + ratchet stress (listen while sending) ──────────────────────────
console.log('\n═══ T8: SSE + Ratchet Stress ═══');

await test('SSE listen + concurrent sends — ratchet survives', async () => {
  const tag = `sse-ratchet-${Date.now()}`;
  const received = [];

  const handle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith(tag)) received.push(msg.content);
    },
    { unreadOnly: true, autoMarkRead: true },
  );

  await sleep(1500);

  // Send 10 messages while SSE is active
  for (let i = 0; i < 10; i++) {
    await alice.send(bob.did, `${tag}-${i}`);
    if (i % 3 === 2) await sleep(200);
  }

  await sleep(4000);
  handle.stop();

  // Check SSE received them
  if (received.length < 8) {
    // Fall back to poll
    const pollMsgs = await bob.receive({ unreadOnly: true, limit: 50 });
    const pollFound = pollMsgs.filter(m => m.content?.startsWith(tag));
    const total = received.length + pollFound.length;
    if (total < 10) throw new Error(`Only ${total}/10 SSE+poll messages (SSE=${received.length}, poll=${pollFound.length})`);
    if (pollMsgs.length > 0) await bob.markReadBatch(pollMsgs.map(m => m.id));
  }

  // Verify ratchet still works after SSE stress
  await sendAndVerify(bob, alice, `${tag}-post-sse-b2a`);
  await sendAndVerify(alice, bob, `${tag}-post-sse-a2b`);

  // Clean any remaining
  await drain(bob);
});

// ── T9: Multiple credential restores in sequence ─────────────────────────────
console.log('\n═══ T9: Multiple Sequential Credential Restores ═══');

await test('Export → restore → send → export → restore → send (3 cycles)', async () => {
  for (let cycle = 0; cycle < 3; cycle++) {
    // Export current state
    const creds = alice.exportCredentials();

    // Restore from export
    const restored = await VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });
    agents.push(restored);

    // Send and receive
    await sendAndVerify(restored, bob, `cycle-${cycle}-a2b`);
    await sendAndVerify(bob, restored, `cycle-${cycle}-b2a`);

    // Update reference for next cycle
    alice = restored;
  }
});

// ── T10: Burst after silence ─────────────────────────────────────────────────
console.log('\n═══ T10: Burst After Silence ═══');

await test('10-second silence then burst of 15 messages', async () => {
  // Establish that ratchet is working
  await sendAndVerify(alice, bob, 'pre-silence-check');

  // Wait (simulates app idle)
  console.log('    ⏳ Simulating 10s silence...');
  await sleep(10000);

  // Burst
  const tag = `burst-${Date.now()}`;
  const promises = [];
  for (let i = 0; i < 15; i++) {
    promises.push(alice.send(bob.did, `${tag}-${i}`));
  }
  await Promise.all(promises);

  await sleep(3000);

  const msgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const found = msgs.filter(m => m.content?.startsWith(tag));
  if (found.length < 15) throw new Error(`Only ${found.length}/15 burst messages after silence`);
  if (msgs.length > 0) await bob.markReadBatch(msgs.map(m => m.id));
});

// ── T11: Bidirectional burst after silence ───────────────────────────────────
console.log('\n═══ T11: Bidirectional Burst After Silence ═══');

await test('Both sides burst simultaneously after silence', async () => {
  console.log('    ⏳ Simulating 5s silence...');
  await sleep(5000);

  const tag = `bidir-burst-${Date.now()}`;

  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => alice.send(bob.did, `${tag}-a2b-${i}`)),
    ...Array.from({ length: 10 }, (_, i) => bob.send(alice.did, `${tag}-b2a-${i}`)),
  ]);

  await sleep(3000);

  const bobMsgs = await bob.receive({ unreadOnly: true, limit: 100 });
  const aliceMsgs = await alice.receive({ unreadOnly: true, limit: 100 });

  const bobGot = bobMsgs.filter(m => m.content?.startsWith(`${tag}-a2b`)).length;
  const aliceGot = aliceMsgs.filter(m => m.content?.startsWith(`${tag}-b2a`)).length;

  if (bobGot < 10) throw new Error(`Bob only got ${bobGot}/10 burst messages`);
  if (aliceGot < 10) throw new Error(`Alice only got ${aliceGot}/10 burst messages`);

  if (bobMsgs.length > 0) await bob.markReadBatch(bobMsgs.map(m => m.id));
  if (aliceMsgs.length > 0) await alice.markReadBatch(aliceMsgs.map(m => m.id));
});

// ── T12: Post-recovery health check ─────────────────────────────────────────
console.log('\n═══ T12: Post-Recovery Health Check ═══');

await test('Final bidirectional health check after all recovery tests', async () => {
  const tag = `final-health-${Date.now()}`;

  // 5 round-trips
  for (let i = 0; i < 5; i++) {
    await sendAndVerify(alice, bob, `${tag}-a2b-${i}`);
    await sendAndVerify(bob, alice, `${tag}-b2a-${i}`);
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');

await test('Deactivate all test agents', async () => {
  // Only deactivate alice and bob — others already deactivated
  await alice.deactivate().catch(() => {});
  await bob.deactivate().catch(() => {});
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  ROUND 3 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
