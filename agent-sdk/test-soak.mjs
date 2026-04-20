/**
 * Round 10: Long-Running Soak Test
 *
 * Sustained messaging over 5 minutes with various patterns:
 * - Continuous bidirectional messaging
 * - SSE monitoring throughout
 * - Periodic credential export/restore
 * - Mixed message sizes
 * - Call signals interspersed
 * - Ratchet health checks every minute (via SSE, not poll)
 *
 * Goal: ZERO decrypt failures over sustained usage
 */

import { VoidlyAgent } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
const SOAK_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const SEND_INTERVAL_MS = 2000; // Send every 2 seconds

let totalSent = 0;
let totalSSEReceived = 0;
let totalDecryptFails = 0;
let totalCallSignals = 0;
let totalCredRestores = 0;

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
console.log('  ROUND 10: LONG-RUNNING SOAK TEST (5 minutes)');
console.log('═'.repeat(70));

const suffix = Date.now().toString(36);
let alice, bob;

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup ═══');

try {
  alice = await VoidlyAgent.register({ name: `soak-alice-${suffix}`, relayUrl: BASE });
  console.log(`  ✅ Alice: ${alice.did.slice(0, 24)}...`);
} catch (e) {
  console.log(`  ❌ Alice registration failed: ${e.message}`);
  process.exit(1);
}

try {
  bob = await VoidlyAgent.register({ name: `soak-bob-${suffix}`, relayUrl: BASE });
  console.log(`  ✅ Bob: ${bob.did.slice(0, 24)}...`);
} catch (e) {
  console.log(`  ❌ Bob registration failed: ${e.message}`);
  process.exit(1);
}

await drain(alice);
await drain(bob);

// Warm up ratchet
await alice.send(bob.did, 'soak-warmup-a2b');
await sleep(500);
await drain(bob);
await bob.send(alice.did, 'soak-warmup-b2a');
await sleep(500);
await drain(alice);

console.log('  ✅ Ratchet warmed up\n');

// ── SSE tracking ─────────────────────────────────────────────────────────────
// Track ALL received messages by content for health checks
const allReceived = new Set();
let aliceSSEHandle, bobSSEHandle;

function startAliceSSE() {
  aliceSSEHandle?.stop();
  aliceSSEHandle = alice.listen(
    (msg) => {
      if (msg.content?.startsWith('soak-')) {
        allReceived.add(msg.content);
        totalSSEReceived++;
      }
    },
    { unreadOnly: true, autoMarkRead: true },
  );
}

function startBobSSE() {
  bobSSEHandle?.stop();
  bobSSEHandle = bob.listen(
    (msg) => {
      if (msg.content?.startsWith('soak-')) {
        allReceived.add(msg.content);
        totalSSEReceived++;
      }
    },
    { unreadOnly: true, autoMarkRead: true },
  );
}

startAliceSSE();
startBobSSE();
console.log('  📡 SSE monitors active\n');

// ── Soak loop ───────────────────────────────────────────────────────────────
const startTime = Date.now();
let minute = 0;
let iteration = 0;

while (Date.now() - startTime < SOAK_DURATION_MS) {
  const elapsed = Date.now() - startTime;
  const currentMinute = Math.floor(elapsed / 60000);

  // Log progress every minute
  if (currentMinute > minute) {
    minute = currentMinute;
    console.log(`\n═══ Minute ${minute}/${Math.ceil(SOAK_DURATION_MS / 60000)} ═══`);
    console.log(`  📤 Sent: ${totalSent} | 📥 SSE received: ${totalSSEReceived} | ❌ Fails: ${totalDecryptFails}`);
    console.log(`  📞 Call signals: ${totalCallSignals} | 🔄 Cred restores: ${totalCredRestores}`);

    // Ratchet health check — use SSE (not poll) since SSE has autoMarkRead
    const healthTag = `soak-health-${Date.now()}`;
    try {
      // A→B
      await alice.send(bob.did, healthTag + '-a2b');
      totalSent++;
      await sleep(3000); // Give SSE time
      if (allReceived.has(healthTag + '-a2b')) {
        console.log('  💚 A→B ratchet healthy');
      } else {
        // Try poll as fallback
        const check = await bob.receive({ unreadOnly: true, limit: 10 });
        const found = check.find(m => m.content === healthTag + '-a2b');
        if (found) {
          console.log('  💚 A→B healthy (via poll fallback)');
        } else {
          totalDecryptFails++;
          console.log('  🔴 A→B ratchet UNHEALTHY');
        }
        if (check.length > 0) await bob.markReadBatch(check.map(m => m.id));
      }

      // B→A
      await bob.send(alice.did, healthTag + '-b2a');
      totalSent++;
      await sleep(3000);
      if (allReceived.has(healthTag + '-b2a')) {
        console.log('  💚 B→A ratchet healthy');
      } else {
        const check = await alice.receive({ unreadOnly: true, limit: 10 });
        const found = check.find(m => m.content === healthTag + '-b2a');
        if (found) {
          console.log('  💚 B→A healthy (via poll fallback)');
        } else {
          totalDecryptFails++;
          console.log('  🔴 B→A ratchet UNHEALTHY');
        }
        if (check.length > 0) await alice.markReadBatch(check.map(m => m.id));
      }
    } catch (e) {
      totalDecryptFails++;
      console.log(`  🔴 Health check error: ${e.message?.slice(0, 60)}`);
    }
  }

  iteration++;

  // Choose action based on iteration
  const action = iteration % 20;

  try {
    if (action < 8) {
      // Regular A→B message (40%)
      const size = [10, 50, 200, 500, 1000][Math.floor(Math.random() * 5)];
      const content = `soak-a2b-${iteration}-${'x'.repeat(size)}`;
      await alice.send(bob.did, content);
      totalSent++;
    } else if (action < 16) {
      // Regular B→A message (40%)
      const size = [10, 50, 200, 500, 1000][Math.floor(Math.random() * 5)];
      const content = `soak-b2a-${iteration}-${'y'.repeat(size)}`;
      await bob.send(alice.did, content);
      totalSent++;
    } else if (action === 16) {
      // Call signal (5%)
      const signal = JSON.stringify({
        type: 'call-offer',
        callId: `soak-call-${iteration}`,
        ts: Date.now(),
        sdp: 'v=0\r\nfake-sdp',
      });
      await alice.send(bob.did, `soak-signal-${signal}`, {
        contentType: 'application/x-call-signal',
        messageType: 'call-signal',
        ttl: 30,
      });
      totalSent++;
      totalCallSignals++;
    } else if (action === 17) {
      // Credential export/restore Alice (5%)
      const creds = alice.exportCredentials();
      alice = await VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });
      startAliceSSE(); // Restart SSE with restored agent
      totalCredRestores++;
    } else if (action === 18) {
      // Concurrent burst (5%)
      await Promise.all([
        alice.send(bob.did, `soak-burst-a2b-${iteration}`),
        bob.send(alice.did, `soak-burst-b2a-${iteration}`),
      ]);
      totalSent += 2;
    } else {
      // Credential export/restore Bob (5%)
      const creds = bob.exportCredentials();
      bob = await VoidlyAgent.fromCredentialsAsync(creds, { baseUrl: BASE });
      startBobSSE(); // Restart SSE with restored agent
      totalCredRestores++;
    }
  } catch (e) {
    totalDecryptFails++;
    console.log(`  ⚠️ Iteration ${iteration} error: ${e.message?.slice(0, 60)}`);
  }

  await sleep(SEND_INTERVAL_MS);
}

// ── Final drain ──────────────────────────────────────────────────────────────
console.log('\n═══ Final Drain ═══');

// Stop SSE
aliceSSEHandle?.stop();
bobSSEHandle?.stop();
await sleep(2000);

// Final poll to catch any stragglers
const finalAlice = await drain(alice);
const finalBob = await drain(bob);
console.log(`  Final drain: Alice=${finalAlice.length}, Bob=${finalBob.length}`);

// ── Final health check (no SSE, pure poll) ──────────────────────────────────
console.log('\n═══ Final Health Check ═══');

let finalHealthy = true;

try {
  await alice.send(bob.did, 'soak-final-a2b');
  await sleep(2000);
  const check = await bob.receive({ unreadOnly: true, limit: 10 });
  const found = check.find(m => m.content === 'soak-final-a2b');
  if (!found) {
    finalHealthy = false;
    console.log(`  🔴 Final A→B FAILED (${check.length} msgs)`);
  } else {
    console.log('  💚 Final A→B healthy');
  }
  if (check.length > 0) await bob.markReadBatch(check.map(m => m.id));
} catch (e) {
  finalHealthy = false;
  console.log(`  🔴 Final A→B error: ${e.message}`);
}

try {
  await bob.send(alice.did, 'soak-final-b2a');
  await sleep(2000);
  const check = await alice.receive({ unreadOnly: true, limit: 10 });
  const found = check.find(m => m.content === 'soak-final-b2a');
  if (!found) {
    finalHealthy = false;
    console.log(`  🔴 Final B→A FAILED (${check.length} msgs)`);
  } else {
    console.log('  💚 Final B→A healthy');
  }
  if (check.length > 0) await alice.markReadBatch(check.map(m => m.id));
} catch (e) {
  finalHealthy = false;
  console.log(`  🔴 Final B→A error: ${e.message}`);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');
await alice.deactivate().catch(() => {});
await bob.deactivate().catch(() => {});

// ── Results ──────────────────────────────────────────────────────────────────
const duration = (Date.now() - startTime) / 1000;
console.log('\n' + '═'.repeat(70));
console.log('  ROUND 10: SOAK TEST RESULTS');
console.log('═'.repeat(70));
console.log(`  Duration: ${duration.toFixed(0)}s (${(duration / 60).toFixed(1)} min)`);
console.log(`  Messages sent: ${totalSent}`);
console.log(`  Messages received via SSE: ${totalSSEReceived}`);
console.log(`  Unique messages seen: ${allReceived.size}`);
console.log(`  Call signals: ${totalCallSignals}`);
console.log(`  Credential restores: ${totalCredRestores}`);
console.log(`  Decrypt failures: ${totalDecryptFails}`);
console.log(`  Final health: ${finalHealthy ? '💚 HEALTHY' : '🔴 UNHEALTHY'}`);
console.log(`  Verdict: ${totalDecryptFails === 0 && finalHealthy ? '✅ PASS' : '❌ FAIL'}`);
console.log('═'.repeat(70));
process.exit(totalDecryptFails > 0 || !finalHealthy ? 1 : 0);
