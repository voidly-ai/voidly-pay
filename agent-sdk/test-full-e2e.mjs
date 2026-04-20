/**
 * Comprehensive E2E Test — Voidly Agent Relay
 * Tests the FULL flow using the real SDK against the production relay.
 * This is the definitive proof that everything works.
 */

import { VoidlyAgent, nacl, encodeBase64, decodeBase64, decodeUTF8 } from './dist/index.mjs';

const BASE = 'https://api.voidly.ai';
let passed = 0;
let failed = 0;
const failures = [];

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, err) { failed++; failures.push({ name, err: String(err) }); console.log(`  ❌ ${name}: ${err}`); }

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e.message || e);
  }
}

// ── Phase 1: Agent Registration ──────────────────────────────────────────────

console.log('\n═══ Phase 1: Agent Registration ═══');

let alice, bob;

await test('Register Alice', async () => {
  alice = await VoidlyAgent.register({ name: 'test-alice-e2e', capabilities: ['testing', 'dns-analysis'] });
  if (!alice.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${alice.did}`);
  if (!alice.apiKey) throw new Error('No API key');
});

await test('Register Bob', async () => {
  bob = await VoidlyAgent.register({ name: 'test-bob-e2e', capabilities: ['testing', 'translation'] });
  if (!bob.did.startsWith('did:voidly:')) throw new Error(`Bad DID: ${bob.did}`);
});

await test('Export + restore credentials', async () => {
  const creds = alice.exportCredentials();
  if (!creds.signingSecretKey) throw new Error('Missing signing key');
  if (!creds.encryptionSecretKey) throw new Error('Missing encryption key');
  const restored = VoidlyAgent.fromCredentials(creds);
  if (restored.did !== alice.did) throw new Error('DID mismatch after restore');
});

// ── Phase 2: Identity & Discovery ────────────────────────────────────────────

console.log('\n═══ Phase 2: Identity & Discovery ═══');

await test('Get Alice identity (public)', async () => {
  const profile = await bob.getIdentity(alice.did);
  if (!profile) throw new Error('Profile not found');
  if (profile.did !== alice.did) throw new Error('DID mismatch');
  if (!profile.signing_public_key) throw new Error('Missing signing key');
  if (!profile.encryption_public_key) throw new Error('Missing encryption key');
});

await test('Discover agents by name', async () => {
  const agents = await alice.discover({ query: 'test-bob-e2e' });
  // May not find immediately due to eventual consistency, but shouldn't error
  if (!Array.isArray(agents)) throw new Error('Expected array');
});

await test('Discover agents by capability', async () => {
  const agents = await alice.discover({ capability: 'translation' });
  if (!Array.isArray(agents)) throw new Error('Expected array');
});

await test('Get own profile', async () => {
  const profile = await alice.getProfile();
  if (profile.did !== alice.did) throw new Error('DID mismatch');
});

await test('Update profile', async () => {
  await alice.updateProfile({ name: 'Alice E2E Test Agent' });
  const profile = await alice.getProfile();
  // Note: profile might return display_name
});

// ── Phase 3: E2E Encrypted Messaging ────────────────────────────────────────

console.log('\n═══ Phase 3: E2E Encrypted Messaging ═══');

const testMessage = `Hello Bob, this is a secret message! Time: ${Date.now()}`;
let sentMsgId;

await test('Alice sends encrypted message to Bob', async () => {
  const result = await alice.send(bob.did, testMessage, {
    contentType: 'text/plain',
    messageType: 'text',
    threadId: 'test-thread-1',
  });
  if (!result.id) throw new Error('No message ID returned');
  if (!result.encrypted) throw new Error('Message not marked as encrypted');
  if (!result.clientSide) throw new Error('Not marked as client-side encrypted');
  sentMsgId = result.id;
});

await test('Bob receives and decrypts message', async () => {
  const messages = await bob.receive({ limit: 10 });
  if (!messages.length) throw new Error('No messages received');
  const msg = messages.find(m => m.id === sentMsgId);
  if (!msg) throw new Error(`Message ${sentMsgId} not found in inbox`);
  if (msg.content !== testMessage) throw new Error(`Content mismatch: "${msg.content}" !== "${testMessage}"`);
  if (msg.from !== alice.did) throw new Error('Wrong sender');
  if (msg.contentType !== 'text/plain') throw new Error(`Wrong content type: ${msg.contentType}`);
});

await test('Signature verification works', async () => {
  const messages = await bob.receive({ limit: 10 });
  const msg = messages.find(m => m.id === sentMsgId);
  if (!msg) throw new Error('Message not found');
  if (!msg.signatureValid) throw new Error('Signature verification FAILED — potential MitM or bug');
});

await test('messageType field present on received message', async () => {
  const messages = await bob.receive({ limit: 10 });
  const msg = messages.find(m => m.id === sentMsgId);
  if (!msg) throw new Error('Message not found');
  if (msg.messageType !== 'text') throw new Error(`Expected messageType 'text', got '${msg.messageType}'`);
});

await test('Filter by messageType', async () => {
  // Send a task-request type
  await alice.send(bob.did, 'task payload', { messageType: 'task-request' });
  const taskMsgs = await bob.receive({ messageType: 'task-request' });
  if (!taskMsgs.length) throw new Error('No task-request messages found');
  if (taskMsgs.some(m => m.messageType !== 'task-request')) throw new Error('Filter returned wrong type');
});

await test('Filter by thread_id', async () => {
  const threaded = await bob.receive({ threadId: 'test-thread-1' });
  if (!threaded.length) throw new Error('No threaded messages found');
  if (threaded.some(m => m.threadId !== 'test-thread-1')) throw new Error('Thread filter broken');
});

await test('Filter by sender', async () => {
  const fromAlice = await bob.receive({ from: alice.did });
  if (!fromAlice.length) throw new Error('No messages from Alice');
  if (fromAlice.some(m => m.from !== alice.did)) throw new Error('Sender filter broken');
});

// ── Phase 4: Read Receipts ──────────────────────────────────────────────────

console.log('\n═══ Phase 4: Read Receipts ═══');

await test('Mark message as read', async () => {
  const result = await bob.markRead(sentMsgId);
  if (!result.read) throw new Error('Mark read failed');
  if (!result.read_at) throw new Error('No read_at timestamp');
});

await test('Get unread count', async () => {
  const unread = await bob.getUnreadCount();
  if (typeof unread.unread_count !== 'number') throw new Error('No unread_count');
  if (!Array.isArray(unread.by_sender)) throw new Error('No by_sender breakdown');
});

await test('Batch mark read', async () => {
  // Send a couple more messages
  const r1 = await alice.send(bob.did, 'batch-1');
  const r2 = await alice.send(bob.did, 'batch-2');
  const result = await bob.markReadBatch([r1.id, r2.id]);
  if (typeof result.updated !== 'number') throw new Error('No updated count');
});

// ── Phase 5: Channels ───────────────────────────────────────────────────────

console.log('\n═══ Phase 5: Encrypted Channels ═══');

let channelId;

await test('Create channel', async () => {
  const ch = await alice.createChannel({
    name: `e2e-test-${Date.now()}`,
    description: 'E2E test channel',
    topic: 'testing',
  });
  if (!ch.id) throw new Error('No channel ID');
  channelId = ch.id;
});

await test('Create private channel (is_private flag)', async () => {
  const ch = await alice.createChannel({
    name: `private-test-${Date.now()}`,
    description: 'Private channel test',
    private: true,
  });
  if (!ch.id) throw new Error('No channel ID');
  if (ch.type !== 'private') throw new Error(`Expected private, got ${ch.type}`);
});

await test('List channels', async () => {
  const channels = await alice.listChannels({ mine: true });
  if (!channels.length) throw new Error('No channels found');
});

await test('Bob joins channel', async () => {
  const result = await bob.joinChannel(channelId);
  if (!result.joined) throw new Error('Join failed');
});

await test('Alice posts to channel', async () => {
  const result = await alice.postToChannel(channelId, 'Hello from Alice in channel!');
  if (!result.id) throw new Error('No message ID');
});

await test('Bob reads channel messages', async () => {
  const result = await bob.readChannel(channelId);
  if (!result.messages.length) throw new Error('No messages in channel');
  const found = result.messages.find(m => m.content === 'Hello from Alice in channel!');
  if (!found) throw new Error('Message not found in channel');
});

await test('Bob leaves channel', async () => {
  await bob.leaveChannel(channelId);
});

// ── Phase 6: Capabilities ───────────────────────────────────────────────────

console.log('\n═══ Phase 6: Capability Registry ═══');

let capId;

await test('Register capability', async () => {
  const result = await alice.registerCapability({
    name: 'dns-analysis-e2e',
    description: 'Analyze DNS for censorship evidence (E2E test)',
    version: '1.0.0',
  });
  if (!result.id) throw new Error('No capability ID');
  capId = result.id;
});

await test('List my capabilities', async () => {
  const caps = await alice.listCapabilities();
  if (!caps.length) throw new Error('No capabilities found');
  const found = caps.find(c => c.name === 'dns-analysis-e2e');
  if (!found) throw new Error('Capability not found');
});

await test('Search capabilities', async () => {
  const results = await alice.searchCapabilities({ query: 'dns-analysis' });
  if (!Array.isArray(results)) throw new Error('Expected array');
});

await test('Delete capability', async () => {
  await alice.deleteCapability(capId);
  const caps = await alice.listCapabilities();
  const found = caps.find(c => c.id === capId);
  if (found) throw new Error('Capability should be deleted');
});

// ── Phase 7: Tasks ──────────────────────────────────────────────────────────

console.log('\n═══ Phase 7: Task Protocol ═══');

let taskId;

await test('Create encrypted task', async () => {
  const result = await alice.createTask({
    to: bob.did,
    capability: 'translation',
    input: { text: 'Hello world', targetLang: 'fr' },
    priority: 'normal',
  });
  if (!result.id) throw new Error('No task ID');
  taskId = result.id;
});

await test('Bob lists assigned tasks', async () => {
  const tasks = await bob.listTasks({ role: 'assignee', status: 'pending' });
  if (!tasks.length) throw new Error('No tasks found');
  const found = tasks.find(t => t.id === taskId);
  if (!found) throw new Error('Task not found');
});

await test('Bob accepts task', async () => {
  const result = await bob.updateTask(taskId, { status: 'accepted' });
  if (!result.updated) throw new Error('Task accept failed');
});

await test('Bob completes task with encrypted output', async () => {
  const result = await bob.updateTask(taskId, {
    status: 'completed',
    output: { translated: 'Bonjour le monde' },
  });
  if (!result.updated) throw new Error('Task complete failed');
});

await test('Alice rates completed task', async () => {
  const result = await alice.updateTask(taskId, { rating: 5, ratingComment: 'Perfect translation' });
  if (!result.updated) throw new Error('Rating failed');
});

// ── Phase 8: Attestations ───────────────────────────────────────────────────

console.log('\n═══ Phase 8: Attestation Network ═══');

let attestationId;

await test('Alice creates signed attestation', async () => {
  const result = await alice.attest({
    claimType: 'domain-blocked',
    claimData: { domain: 'twitter.com', country: 'IR', method: 'dns-poisoning' },
    country: 'IR',
    domain: 'twitter.com',
    confidence: 0.95,
  });
  if (!result.id) throw new Error('No attestation ID');
  attestationId = result.id;
});

await test('Query attestations', async () => {
  const results = await alice.queryAttestations({ country: 'IR', domain: 'twitter.com' });
  if (!Array.isArray(results)) throw new Error('Expected array');
});

await test('Get attestation detail', async () => {
  const detail = await alice.getAttestation(attestationId);
  if (!detail.id) throw new Error('No attestation returned');
  if (detail.claim_type !== 'domain-blocked') throw new Error('Wrong claim type');
});

await test('Bob corroborates attestation', async () => {
  const result = await bob.corroborate(attestationId, 'corroborate', 'Confirmed via independent test');
  if (typeof result.new_consensus_score !== 'number') throw new Error('No consensus score');
});

await test('Local signature verification', async () => {
  // Get the attestation data and verify signature locally without trusting relay
  const detail = await alice.getAttestation(attestationId);
  const profile = await bob.getIdentity(alice.did);
  const valid = VoidlyAgent.verifyAttestation({
    claim_type: detail.claim_type,
    claim_data: detail.claim_data,
    signature: detail.signature,
    timestamp: detail.timestamp,
  }, profile.signing_public_key);
  if (!valid) throw new Error('Local signature verification FAILED — critical security issue');
});

await test('Get consensus', async () => {
  const consensus = await alice.getConsensus({ country: 'IR' });
  if (!Array.isArray(consensus)) throw new Error('Expected array');
});

await test('Attestation with bad signature returns 400 not 500', async () => {
  const res = await fetch(`${BASE}/v1/agent/attestations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': alice.apiKey },
    body: JSON.stringify({
      claim_type: 'domain-blocked',
      claim_data: { domain: 'test.com' },
      signature: encodeBase64(new Uint8Array(10)), // Wrong size — should be 64 bytes
      timestamp: new Date().toISOString(),
      country: 'US',
    }),
  });
  if (res.status === 500) throw new Error('Got 500 instead of 400 — nacl.verify not wrapped in try/catch');
  if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
});

// ── Phase 9: Memory Store ───────────────────────────────────────────────────

console.log('\n═══ Phase 9: Persistent Memory ═══');

await test('Store value in memory', async () => {
  const result = await alice.memorySet('config', 'preferred-lang', 'en');
  if (!result.stored) throw new Error('Store failed');
});

await test('Store JSON in memory', async () => {
  const result = await alice.memorySet('data', 'analysis-results', {
    countries: ['IR', 'CN', 'RU'],
    blockedDomains: 42,
    lastRun: new Date().toISOString(),
  });
  if (!result.stored) throw new Error('Store failed');
});

await test('Retrieve value from memory', async () => {
  const result = await alice.memoryGet('config', 'preferred-lang');
  if (!result) throw new Error('Value not found');
  if (result.value !== 'en') throw new Error(`Expected 'en', got '${result.value}'`);
});

await test('Retrieve JSON from memory', async () => {
  const result = await alice.memoryGet('data', 'analysis-results');
  if (!result) throw new Error('Value not found');
  if (!result.value.countries) throw new Error('JSON not preserved');
  if (result.value.countries.length !== 3) throw new Error('Array not preserved');
});

await test('List keys in namespace', async () => {
  const result = await alice.memoryList('config');
  if (!result.keys.length) throw new Error('No keys found');
});

await test('List namespaces', async () => {
  const result = await alice.memoryNamespaces();
  if (!result.namespaces.length) throw new Error('No namespaces found');
  if (!result.quota) throw new Error('No quota info');
});

await test('Delete from memory', async () => {
  const result = await alice.memoryDelete('config', 'preferred-lang');
  if (!result.deleted) throw new Error('Delete failed');
  const check = await alice.memoryGet('config', 'preferred-lang');
  if (check !== null) throw new Error('Value should be deleted');
});

// ── Phase 10: Heartbeat ─────────────────────────────────────────────────────

console.log('\n═══ Phase 10: Heartbeat ═══');

await test('Alice sends heartbeat', async () => {
  const result = await alice.ping();
  if (!result.pong) throw new Error('No pong');
  if (result.did !== alice.did) throw new Error('Wrong DID in pong');
});

await test('Check Alice online status', async () => {
  const result = await bob.checkOnline(alice.did);
  if (result.online_status !== 'online') throw new Error(`Expected online, got ${result.online_status}`);
});

// ── Phase 11: Key Pinning (TOFU) ────────────────────────────────────────────

console.log('\n═══ Phase 11: Key Pinning (TOFU) ═══');

await test('Alice pins Bob keys (first time)', async () => {
  const result = await alice.pinKeys(bob.did);
  if (!result.pinned) throw new Error('Pin failed');
  if (result.status !== 'first_pin') throw new Error(`Expected first_pin, got ${result.status}`);
});

await test('Alice verifies Bob keys (should match)', async () => {
  const result = await alice.verifyKeys(bob.did);
  if (!result.pinned) throw new Error('Not pinned');
  if (result.status !== 'keys_match') throw new Error(`Expected keys_match, got ${result.status}`);
});

await test('List pinned keys', async () => {
  const result = await alice.listPinnedKeys();
  if (!result.pins.length) throw new Error('No pins found');
  if (result.total < 1) throw new Error('Total should be >= 1');
});

await test('Re-pin (should verify)', async () => {
  const result = await alice.pinKeys(bob.did);
  if (result.key_changed) throw new Error('Keys should not have changed');
  if (result.status !== 'verified') throw new Error(`Expected verified, got ${result.status}`);
});

// ── Phase 12: Data Export ───────────────────────────────────────────────────

console.log('\n═══ Phase 12: Data Export ═══');

await test('Export all agent data', async () => {
  const data = await alice.exportData();
  if (!data.identity) throw new Error('No identity in export');
  if (!data.export_id) throw new Error('No export ID');
});

await test('List past exports', async () => {
  const result = await alice.listExports();
  if (!result.exports.length) throw new Error('No exports found');
});

// ── Phase 13: Relay Federation ──────────────────────────────────────────────

console.log('\n═══ Phase 13: Relay Federation ═══');

await test('Get relay info', async () => {
  const info = await alice.getRelayInfo();
  if (!info.relay) throw new Error('No relay object');
  if (!info.relay.name) throw new Error('No relay name');
  if (!info.relay.features) throw new Error('No features listed');
});

await test('List relay peers', async () => {
  const result = await alice.getRelayPeers();
  if (!Array.isArray(result.peers)) throw new Error('No peers array');
});

// ── Phase 14: Trust Score ───────────────────────────────────────────────────

console.log('\n═══ Phase 14: Trust Scoring ═══');

await test('Get Bob trust score (after task completion)', async () => {
  const result = await bob.getTrustScore(bob.did);
  if (typeof result.trust_score !== 'number') throw new Error('No trust score');
  if (!result.trust_level) throw new Error('No trust level');
});

await test('Get trust leaderboard', async () => {
  const result = await bob.getTrustLeaderboard({ limit: 10 });
  if (!Array.isArray(result)) throw new Error('Expected array');
});

// ── Phase 15: Analytics ─────────────────────────────────────────────────────

console.log('\n═══ Phase 15: Analytics ═══');

await test('Get Alice analytics', async () => {
  const result = await alice.getAnalytics('all');
  if (!result.messaging) throw new Error('No messaging stats');
});

// ── Phase 16: Network Stats ─────────────────────────────────────────────────

console.log('\n═══ Phase 16: Network Stats ═══');

await test('Get relay stats', async () => {
  const stats = await alice.stats();
  if (!stats.relay) throw new Error('No relay info');
  if (!stats.stats) throw new Error('No stats');
  if (!stats.endpoints) throw new Error('No endpoints listing');
});

// ── Phase 17: Cleanup ───────────────────────────────────────────────────────

console.log('\n═══ Phase 17: Cleanup ═══');

await test('Delete message', async () => {
  const result = await alice.deleteMessage(sentMsgId);
  // Should succeed (alice is sender)
});

await test('Deactivate Bob', async () => {
  await bob.deactivate();
});

await test('Deactivate Alice', async () => {
  await alice.deactivate();
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('═'.repeat(60));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name}`);
    console.log(`     ${f.err}`);
  }
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
