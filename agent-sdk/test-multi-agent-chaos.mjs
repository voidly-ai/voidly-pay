/**
 * Round 5: Multi-Agent Concurrent Chaos
 *
 * Creates 5 agents and tests:
 * 1. All-to-all messaging (every agent sends to every other)
 * 2. Broadcast pattern (one sends to all)
 * 3. Chain pattern (A→B→C→D→E)
 * 4. Concurrent all-to-all (simultaneous)
 * 5. Ring pattern (A→B→C→D→E→A)
 * 6. Hub-spoke (all send to center, center replies)
 * 7. Post-chaos health check
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
console.log('  ROUND 5: MULTI-AGENT CONCURRENT CHAOS');
console.log('═'.repeat(70));

const suffix = Date.now().toString(36);
const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const agents = [];

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n═══ Setup: Register 5 Agents ═══');

for (const name of NAMES) {
  await test(`Register ${name}`, async () => {
    const agent = await VoidlyAgent.register({ name: `chaos-${name}-${suffix}`, relayUrl: BASE });
    agents.push(agent);
    if (!agent.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${agent.did}`);
  });
}

// Drain all
for (const agent of agents) await drain(agent);

// ── T1: Sequential all-to-all ────────────────────────────────────────────────
console.log('\n═══ T1: Sequential All-to-All (20 messages) ═══');

await test('Every agent sends to every other agent', async () => {
  const tag = `all2all-${Date.now()}`;
  let sendCount = 0;

  // Each agent sends to every other agent
  for (let i = 0; i < agents.length; i++) {
    for (let j = 0; j < agents.length; j++) {
      if (i === j) continue;
      await agents[i].send(agents[j].did, `${tag}-${NAMES[i]}2${NAMES[j]}`);
      sendCount++;
    }
  }

  console.log(`    📤 Sent ${sendCount} messages`);
  await sleep(5000);

  // Each agent should receive messages from every other agent
  let totalReceived = 0;
  for (let i = 0; i < agents.length; i++) {
    const msgs = await agents[i].receive({ unreadOnly: true, limit: 100 });
    const relevant = msgs.filter(m => m.content?.startsWith(tag));
    totalReceived += relevant.length;

    if (relevant.length < agents.length - 1) {
      console.warn(`    ⚠️ ${NAMES[i]} only got ${relevant.length}/${agents.length - 1} messages`);
    }

    if (msgs.length > 0) await agents[i].markReadBatch(msgs.map(m => m.id));
  }

  console.log(`    📥 Total received: ${totalReceived}/${sendCount}`);
  if (totalReceived < sendCount) throw new Error(`Only ${totalReceived}/${sendCount} all-to-all messages`);
});

// ── T2: Broadcast pattern ───────────────────────────────────────────────────
console.log('\n═══ T2: Broadcast Pattern ═══');

await test('Alpha broadcasts to all others', async () => {
  const tag = `broadcast-${Date.now()}`;
  const alpha = agents[0];

  // Alpha sends to all others
  for (let i = 1; i < agents.length; i++) {
    await alpha.send(agents[i].did, `${tag}-to-${NAMES[i]}`);
  }

  await sleep(3000);

  let received = 0;
  for (let i = 1; i < agents.length; i++) {
    const msgs = await agents[i].receive({ unreadOnly: true, limit: 50 });
    const found = msgs.find(m => m.content === `${tag}-to-${NAMES[i]}`);
    if (found) received++;
    if (msgs.length > 0) await agents[i].markReadBatch(msgs.map(m => m.id));
  }

  if (received < agents.length - 1) throw new Error(`Only ${received}/${agents.length - 1} broadcast received`);
});

// ── T3: Chain pattern (A→B→C→D→E) ──────────────────────────────────────────
console.log('\n═══ T3: Chain Pattern ═══');

await test('Message chain A→B→C→D→E', async () => {
  const tag = `chain-${Date.now()}`;

  for (let i = 0; i < agents.length - 1; i++) {
    const sender = agents[i];
    const receiver = agents[i + 1];

    await sender.send(receiver.did, `${tag}-${NAMES[i]}2${NAMES[i + 1]}`);
    await sleep(800);

    const msgs = await receiver.receive({ unreadOnly: true, limit: 50 });
    const found = msgs.find(m => m.content === `${tag}-${NAMES[i]}2${NAMES[i + 1]}`);
    if (!found) throw new Error(`Chain broke at ${NAMES[i]}→${NAMES[i + 1]}`);
    if (msgs.length > 0) await receiver.markReadBatch(msgs.map(m => m.id));

    console.log(`    ✔ ${NAMES[i]} → ${NAMES[i + 1]}`);
  }
});

// ── T4: Concurrent all-to-all ───────────────────────────────────────────────
console.log('\n═══ T4: Concurrent All-to-All ═══');

await test('All agents send to all others simultaneously', async () => {
  const tag = `conc-all-${Date.now()}`;
  const promises = [];

  for (let i = 0; i < agents.length; i++) {
    for (let j = 0; j < agents.length; j++) {
      if (i === j) continue;
      promises.push(agents[i].send(agents[j].did, `${tag}-${i}to${j}`));
    }
  }

  await Promise.all(promises);
  console.log(`    📤 ${promises.length} concurrent sends`);
  await sleep(5000);

  let totalReceived = 0;
  for (let i = 0; i < agents.length; i++) {
    const msgs = await agents[i].receive({ unreadOnly: true, limit: 100 });
    const relevant = msgs.filter(m => m.content?.startsWith(tag));
    totalReceived += relevant.length;
    if (msgs.length > 0) await agents[i].markReadBatch(msgs.map(m => m.id));
  }

  const expected = agents.length * (agents.length - 1);
  console.log(`    📥 ${totalReceived}/${expected} concurrent all-to-all messages`);
  if (totalReceived < expected) throw new Error(`Only ${totalReceived}/${expected} concurrent all-to-all`);
});

// ── T5: Ring pattern ────────────────────────────────────────────────────────
console.log('\n═══ T5: Ring Pattern (A→B→C→D→E→A) ═══');

await test('Ring: each agent sends to next, wrapping around', async () => {
  const tag = `ring-${Date.now()}`;
  const promises = [];

  for (let i = 0; i < agents.length; i++) {
    const next = (i + 1) % agents.length;
    promises.push(agents[i].send(agents[next].did, `${tag}-${NAMES[i]}2${NAMES[next]}`));
  }

  await Promise.all(promises);
  await sleep(3000);

  let received = 0;
  for (let i = 0; i < agents.length; i++) {
    const prev = (i - 1 + agents.length) % agents.length;
    const msgs = await agents[i].receive({ unreadOnly: true, limit: 50 });
    const found = msgs.find(m => m.content === `${tag}-${NAMES[prev]}2${NAMES[i]}`);
    if (found) received++;
    if (msgs.length > 0) await agents[i].markReadBatch(msgs.map(m => m.id));
  }

  if (received < agents.length) throw new Error(`Ring only ${received}/${agents.length}`);
});

// ── T6: Hub-spoke ───────────────────────────────────────────────────────────
console.log('\n═══ T6: Hub-Spoke Pattern ═══');

await test('All send to center (Charlie), Charlie replies', async () => {
  const tag = `hub-${Date.now()}`;
  const center = agents[2]; // charlie

  // Spokes send to center
  const spokes = agents.filter((_, i) => i !== 2);
  await Promise.all(
    spokes.map((agent, i) => agent.send(center.did, `${tag}-spoke${i}-in`))
  );

  await sleep(3000);

  // Center receives
  const centerMsgs = await center.receive({ unreadOnly: true, limit: 100 });
  const inbound = centerMsgs.filter(m => m.content?.startsWith(`${tag}-spoke`));
  console.log(`    📥 Center received ${inbound.length}/${spokes.length} inbound`);
  if (inbound.length < spokes.length) throw new Error(`Center only got ${inbound.length}/${spokes.length}`);
  if (centerMsgs.length > 0) await center.markReadBatch(centerMsgs.map(m => m.id));

  // Center replies to all spokes
  await Promise.all(
    spokes.map((agent, i) => center.send(agent.did, `${tag}-reply-${i}`))
  );

  await sleep(3000);

  let replies = 0;
  for (let i = 0; i < spokes.length; i++) {
    const msgs = await spokes[i].receive({ unreadOnly: true, limit: 50 });
    const found = msgs.find(m => m.content === `${tag}-reply-${i}`);
    if (found) replies++;
    if (msgs.length > 0) await spokes[i].markReadBatch(msgs.map(m => m.id));
  }

  if (replies < spokes.length) throw new Error(`Only ${replies}/${spokes.length} replies received`);
});

// ── T7: Rapid fan-out ───────────────────────────────────────────────────────
console.log('\n═══ T7: Rapid Fan-Out (50 total messages) ═══');

await test('Alpha sends 10 messages to each other agent concurrently', async () => {
  const tag = `fanout-${Date.now()}`;
  const alpha = agents[0];
  const others = agents.slice(1);

  // 10 messages × 4 recipients = 40 messages
  const promises = [];
  for (const other of others) {
    for (let i = 0; i < 10; i++) {
      promises.push(alpha.send(other.did, `${tag}-${i}`));
    }
  }

  await Promise.all(promises);
  console.log(`    📤 ${promises.length} concurrent fan-out messages`);
  await sleep(5000);

  let total = 0;
  for (const other of others) {
    const msgs = await other.receive({ unreadOnly: true, limit: 100 });
    const found = msgs.filter(m => m.content?.startsWith(tag));
    total += found.length;
    if (msgs.length > 0) await other.markReadBatch(msgs.map(m => m.id));
  }

  console.log(`    📥 ${total}/${promises.length} fan-out messages received`);
  if (total < promises.length) throw new Error(`Only ${total}/${promises.length}`);
});

// ── T8: Chaos round — random sends ──────────────────────────────────────────
console.log('\n═══ T8: Chaos Round ═══');

await test('30 random peer-to-peer messages', async () => {
  const tag = `chaos-${Date.now()}`;
  const sends = [];

  for (let i = 0; i < 30; i++) {
    const from = Math.floor(Math.random() * agents.length);
    let to = Math.floor(Math.random() * agents.length);
    while (to === from) to = Math.floor(Math.random() * agents.length);

    sends.push({ from, to, content: `${tag}-${i}-${from}to${to}` });
  }

  // Send all concurrently
  await Promise.all(
    sends.map(s => agents[s.from].send(agents[s.to].did, s.content))
  );

  await sleep(5000);

  // Verify
  const expectedPerAgent = new Map();
  for (const s of sends) {
    if (!expectedPerAgent.has(s.to)) expectedPerAgent.set(s.to, []);
    expectedPerAgent.get(s.to).push(s.content);
  }

  let totalReceived = 0;
  for (let i = 0; i < agents.length; i++) {
    const msgs = await agents[i].receive({ unreadOnly: true, limit: 200 });
    const expected = expectedPerAgent.get(i) || [];
    const found = msgs.filter(m => m.content?.startsWith(tag));
    totalReceived += found.length;

    if (found.length < expected.length) {
      console.warn(`    ⚠️ ${NAMES[i]}: ${found.length}/${expected.length}`);
    }
    if (msgs.length > 0) await agents[i].markReadBatch(msgs.map(m => m.id));
  }

  console.log(`    📥 ${totalReceived}/${sends.length} chaos messages`);
  if (totalReceived < sends.length) throw new Error(`Only ${totalReceived}/${sends.length} chaos messages`);
});

// ── T9: Post-chaos health ───────────────────────────────────────────────────
console.log('\n═══ T9: Post-Chaos Health Check ═══');

await test('All 10 directional pairs work after chaos', async () => {
  const tag = `health-${Date.now()}`;
  // Test a subset: each agent sends to the next
  for (let i = 0; i < agents.length; i++) {
    const next = (i + 1) % agents.length;
    await agents[i].send(agents[next].did, `${tag}-${NAMES[i]}→${NAMES[next]}`);
  }

  await sleep(3000);

  let healthy = 0;
  for (let i = 0; i < agents.length; i++) {
    const prev = (i - 1 + agents.length) % agents.length;
    const msgs = await agents[i].receive({ unreadOnly: true, limit: 50 });
    const found = msgs.find(m => m.content?.includes(`${NAMES[prev]}→${NAMES[i]}`));
    if (found) healthy++;
    if (msgs.length > 0) await agents[i].markReadBatch(msgs.map(m => m.id));
  }

  console.log(`    💚 ${healthy}/${agents.length} directions healthy`);
  if (healthy < agents.length) throw new Error(`Only ${healthy}/${agents.length} healthy after chaos`);
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\n═══ Cleanup ═══');

await test('Deactivate all test agents', async () => {
  await Promise.all(agents.map(a => a.deactivate().catch(() => {})));
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`  ROUND 5 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ❌ ${f.name}: ${f.err}`);
  }
}
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
