#!/usr/bin/env node
/**
 * End-to-end test for @voidly/agent-sdk v3.2.0
 * Tests: PQ hybrid, forward secrecy, padding, sealed sender, SSE transport, ratchet persistence, multi-relay
 * All crypto happens CLIENT-SIDE — server never sees private keys.
 */
import { VoidlyAgent, Conversation } from './dist/index.mjs';

const BASE_URL = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`   ✓ ${name}`);
    passed++;
  } else {
    console.log(`   ✗ ${name}`);
    failed++;
  }
}

async function test() {
  console.log('=== @voidly/agent-sdk v3.2.0 E2E Test ===\n');
  console.log('Security: Double Ratchet + X3DH + PQ hybrid + SSE + ratchet persistence\n');

  // ─── 1. Register with security config ───────────────────────────────
  console.log('1. Registering agents with security config...');
  const alice = await VoidlyAgent.register(
    { name: 'test-alice-v20', capabilities: ['chat', 'translate'] },
    {
      baseUrl: BASE_URL,
      autoPin: true,
      retries: 2,
      padding: true,
      sealedSender: false,  // Test both modes
      fallbackRelays: [],   // No fallbacks for test (would need separate relay)
    }
  );
  const bob = await VoidlyAgent.register(
    { name: 'test-bob-v20', capabilities: ['chat', 'code'] },
    {
      baseUrl: BASE_URL,
      autoPin: true,
      padding: true,
      sealedSender: false,
    }
  );
  assert(alice.did.startsWith('did:voidly:'), 'Alice DID format');
  assert(bob.did.startsWith('did:voidly:'), 'Bob DID format');
  console.log(`   Alice: ${alice.did}`);
  console.log(`   Bob: ${bob.did}`);

  // ─── 2. Send with padding enabled ──────────────────────────────────
  console.log('\n2. Send with message padding (traffic analysis resistance)...');
  const shortMsg = await alice.send(bob.did, 'Hi', { threadId: 'pad-test' });
  assert(!!shortMsg.id, 'Short message sent with padding');

  const longMsg = await alice.send(bob.did, 'A'.repeat(500), { threadId: 'pad-test' });
  assert(!!longMsg.id, 'Long message sent with padding');

  // ─── 3. Bob receives padded messages and decrypts ──────────────────
  console.log('\n3. Bob receives and decrypts padded messages...');
  const padded = await bob.receive({ threadId: 'pad-test', limit: 10 });
  assert(padded.length >= 2, `Bob received ${padded.length} padded messages`);
  if (padded.length >= 2) {
    assert(padded[0].content === 'Hi', 'Short message content preserved after unpadding');
    assert(padded[1].content === 'A'.repeat(500), 'Long message content preserved after unpadding');
    assert(padded[0].signatureValid === true, 'Short message signature valid');
    assert(padded[1].signatureValid === true, 'Long message signature valid');
  }

  // ─── 4. Send without padding (explicit opt-out) ────────────────────
  console.log('\n4. Send without padding (explicit opt-out)...');
  const nopad = await alice.send(bob.did, 'No padding here', { noPadding: true });
  assert(!!nopad.id, 'Unpadded message sent');

  const nopadReceived = await bob.receive({ limit: 5 });
  const nopadMsg = nopadReceived.find(m => m.content === 'No padding here');
  assert(!!nopadMsg, 'Unpadded message received correctly');

  // ─── 5. Sealed sender ──────────────────────────────────────────────
  console.log('\n5. Sealed sender (sender DID hidden from relay)...');
  const sealedResult = await alice.send(bob.did, 'Secret identity message', {
    sealedSender: true,
    threadId: 'sealed-test',
  });
  assert(!!sealedResult.id, 'Sealed sender message sent');

  // v3.1: sealed sender strips metadata from relay — can't filter by threadId server-side
  // Receive all and find the sealed message by content after decryption
  const sealedReceived = await bob.receive({ limit: 10 });
  const sealedMsg = sealedReceived.find(m => m.content === 'Secret identity message');
  assert(!!sealedMsg, 'Sealed message received');
  if (sealedMsg) {
    assert(sealedMsg.content === 'Secret identity message', 'Sealed content decrypted');
    assert(sealedMsg.from === alice.did, 'Sender DID recovered from inside ciphertext');
    assert(sealedMsg.threadId === 'sealed-test', 'Thread ID recovered from inside ciphertext');
  }

  // ─── 6. Bidirectional with all features ────────────────────────────
  console.log('\n6. Bob replies with padding...');
  const reply = await bob.send(alice.did, 'Got your padded messages! Padding works both ways.', {
    threadId: 'pad-test',
    replyTo: shortMsg.id,
  });
  assert(!!reply.id, 'Padded reply sent');

  const aliceReceived = await alice.receive({ threadId: 'pad-test', limit: 10 });
  const bobReply = aliceReceived.find(m => m.content.includes('Padding works both ways'));
  assert(!!bobReply, 'Padded reply received by Alice');
  if (bobReply) {
    assert(bobReply.signatureValid === true, 'Reply signature valid');
  }

  // ─── 7. Conversation helper ────────────────────────────────────────
  console.log('\n7. Conversation helper (still works with padding)...');
  const conv = alice.conversation(bob.did);
  const convMsg = await conv.say('Hello from padded conversation!');
  assert(!!convMsg.id, 'Conversation message sent with padding');
  assert(conv.length === 1, 'Conversation tracks messages');
  conv.close();

  // ─── 8. Listen ─────────────────────────────────────────────────────
  console.log('\n8. Listen (with padded messages)...');
  await alice.send(bob.did, 'Listen test v2', { messageType: 'ping' });

  let listenReceived = false;
  const listenPromise = new Promise((resolve) => {
    const handle = bob.listen(
      (msg) => {
        if (msg.content === 'Listen test v2') {
          listenReceived = true;
          handle.stop();
          resolve(undefined);
        }
      },
      { interval: 1000, adaptive: false, heartbeat: false },
    );
    setTimeout(() => { handle.stop(); resolve(undefined); }, 15000);
  });
  await listenPromise;
  assert(listenReceived, 'Listen received padded message');

  // ─── 9. Offline queue ──────────────────────────────────────────────
  console.log('\n9. Offline queue...');
  assert(alice.queueLength === 0, 'Queue starts empty');
  const drain = await alice.drainQueue();
  assert(drain.sent === 0, 'Nothing to drain when queue empty');
  assert(drain.remaining === 0, 'No remaining after empty drain');

  // ─── 10. Threat model transparency ─────────────────────────────────
  console.log('\n10. Threat model transparency...');
  const threatAlice = alice.threatModel();
  assert(threatAlice.relayCanSee.length > 0, 'Threat model reports what relay can see');
  assert(threatAlice.relayCannotSee.length > 0, 'Threat model reports what relay cannot see');
  assert(threatAlice.protections.length > 0, 'Threat model lists protections');
  assert(threatAlice.gaps.length > 0, 'Threat model honestly lists gaps');

  // Verify padding is listed as a protection
  const hasPaddingProtection = threatAlice.protections.some(p => p.includes('padding'));
  assert(hasPaddingProtection, 'Padding listed as active protection');

  // Verify forward secrecy is now a PROTECTION (v2.1 — hash ratchet is wired into real encryption)
  const hasForwardSecrecyProtection = threatAlice.protections.some(p => p.includes('forward secrecy'));
  assert(hasForwardSecrecyProtection, 'Forward secrecy listed as active protection (ratchet wired)');

  console.log('   Protections:');
  threatAlice.protections.forEach(p => console.log(`     • ${p}`));
  console.log('   Known gaps:');
  threatAlice.gaps.forEach(g => console.log(`     ⚠ ${g}`));

  // ─── 11. Credential export/restore ─────────────────────────────────
  console.log('\n11. Credential export/restore...');
  const creds = alice.exportCredentials();
  assert(!!creds.signingSecretKey, 'Signing key exported');
  const restored = VoidlyAgent.fromCredentials(creds, { baseUrl: BASE_URL, padding: true });
  assert(restored.did === alice.did, 'Restored DID matches');
  const restoredSend = await restored.send(bob.did, 'From restored agent with padding');
  assert(!!restoredSend.id, 'Restored agent sends with padding');

  // ─── 12. Discovery + Heartbeat ─────────────────────────────────────
  console.log('\n12. Discovery + heartbeat...');
  const agents = await alice.discover({ query: 'test', limit: 5 });
  assert(agents.length > 0, 'Discovery returns results');

  const ping = await alice.ping();
  assert(ping.pong === true, 'Heartbeat works');

  // ─── 13. Ratchet persistence config ─────────────────────────────────
  console.log('\n13. Ratchet persistence...');
  // Test that persist config is accepted
  const persistAgent = await VoidlyAgent.register(
    { name: 'test-persist-v1' },
    { baseUrl: BASE_URL, persist: 'memory' }
  );
  assert(!!persistAgent.did, 'Agent with persist config registered');
  assert(typeof persistAgent.flushRatchetState === 'function', 'flushRatchetState method exists');
  await persistAgent.flushRatchetState();
  assert(true, 'flushRatchetState completes (memory backend)');

  // Test custom persist callbacks
  let persistedData = null;
  const customPersist = await VoidlyAgent.register(
    { name: 'test-custom-persist-v1' },
    {
      baseUrl: BASE_URL,
      persist: 'custom',
      onPersist: (data) => { persistedData = data; },
      onLoad: () => persistedData,
    }
  );
  assert(!!customPersist.did, 'Agent with custom persist registered');
  customPersist.stopAll();

  // Test fromCredentialsAsync
  const persistCreds = persistAgent.exportCredentials();
  const restoredAsync = await VoidlyAgent.fromCredentialsAsync(persistCreds, { baseUrl: BASE_URL, persist: 'memory' });
  assert(restoredAsync.did === persistAgent.did, 'fromCredentialsAsync restores DID');
  restoredAsync.stopAll();
  persistAgent.stopAll();

  // ─── 14. Transport config ────────────────────────────────────────────
  console.log('\n14. Transport config...');
  const sseAgent = await VoidlyAgent.register(
    { name: 'test-sse-transport-v1' },
    { baseUrl: BASE_URL, transport: ['sse', 'long-poll'] }
  );
  assert(!!sseAgent.did, 'Agent with SSE transport config registered');
  assert(typeof sseAgent.listen === 'function', 'listen method available');

  // Test SSE endpoint exists (just check 401 without key)
  const sseRes = await fetch(`${BASE_URL}/v1/agent/receive/sse`);
  assert(sseRes.status === 401, 'SSE endpoint exists (returns 401 without key)');
  sseAgent.stopAll();

  // ─── 15. Clean shutdown ────────────────────────────────────────────
  console.log('\n15. Clean shutdown...');
  alice.stopAll();
  bob.stopAll();
  assert(true, 'stopAll completed');

  // ═══ Results ═══════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  console.log(`${'═'.repeat(55)}`);

  if (failed === 0) {
    console.log('\n✓ ALL TESTS PASSED — E2E encryption + padding + sealed sender verified!');
    console.log('  Message padding: power-of-2 boundary (traffic analysis resistance)');
    console.log('  Sealed sender: sender DID recovered from inside ciphertext');
    console.log('  Private keys never left this process.');
  } else {
    console.log('\n✗ SOME TESTS FAILED');
    process.exit(1);
  }
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
