#!/usr/bin/env node
/**
 * Post-Quantum + Ratchet Persistence — Future-proof encrypted messaging.
 *
 * Run:  node examples/post-quantum.mjs
 *
 * Features demonstrated:
 *   1. ML-KEM-768 hybrid key exchange (NIST FIPS 203) — quantum-resistant
 *   2. Double Ratchet forward secrecy — compromise now can't decrypt past messages
 *   3. Ratchet persistence — session survives agent restarts
 *   4. Sealed sender — relay can't see who sent the message
 *   5. Deniable auth — both parties can produce the signature (plausible deniability)
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

// ─── Register with full security config ─────────────────────────────────────
const alice = await VoidlyAgent.register(
  { name: 'pq-alice', capabilities: ['chat', 'intel'] },
  {
    pq: true,              // Enable ML-KEM-768 post-quantum hybrid
    padding: true,         // Pad all messages to power-of-2 (traffic analysis resistance)
    sealedSender: true,    // Hide sender DID from relay metadata
    deniable: true,        // HMAC signatures (both parties can produce — deniable)
    persist: 'memory',     // Ratchet state persists in memory (use 'file' or 'relay' for disk)
    autoPin: true,         // TOFU: pin first-seen keys, warn on change
  }
);

const bob = await VoidlyAgent.register(
  { name: 'pq-bob', capabilities: ['chat', 'analysis'] },
  {
    pq: true,
    padding: true,
    sealedSender: true,
    deniable: true,
    persist: 'memory',
    autoPin: true,
  }
);

console.log(`Alice: ${alice.did} (PQ + sealed + deniable)`);
console.log(`Bob:   ${bob.did} (PQ + sealed + deniable)\n`);

// ─── Verify post-quantum is active ──────────────────────────────────────────
const threat = alice.threatModel();
console.log('Active protections:');
threat.protections.forEach(p => console.log(`  ✓ ${p}`));
console.log('Known gaps:');
threat.gaps.forEach(g => console.log(`  ⚠ ${g}`));

// ─── Send messages with full protection stack ───────────────────────────────
console.log('\nSending with PQ hybrid + Double Ratchet + sealed sender + padding...');
await alice.send(bob.did, 'Quantum-resistant hello from Alice', { threadId: 'pq-demo' });
await alice.send(bob.did, 'Even a quantum computer cannot decrypt this retroactively');

// Bob receives and decrypts
const messages = await bob.receive({ limit: 10 });
for (const msg of messages) {
  console.log(`\n  Bob received: "${msg.content}"`);
  console.log(`    From:            ${msg.from.slice(0, 30)}...`);
  console.log(`    Signature valid: ${msg.signatureValid}`);
}

// ─── Demonstrate forward secrecy ────────────────────────────────────────────
console.log('\n─── Forward Secrecy Demo ───');
console.log('Ratchet advances with each message — past keys are deleted.');
console.log('Even if an attacker compromises the agent NOW, they cannot');
console.log('decrypt messages that were already received and processed.\n');

// Bob replies — DH ratchet advances
await bob.send(alice.did, 'Reply from Bob — ratchet advanced');
const replies = await alice.receive({ limit: 5 });
for (const r of replies) {
  console.log(`  Alice received: "${r.content}"`);
}

// ─── Credential export (includes ratchet state) ─────────────────────────────
console.log('\n─── Credential Export ───');
const creds = alice.exportCredentials();
console.log(`  DID:          ${creds.did}`);
console.log(`  Signing key:  ${creds.signingSecretKey.slice(0, 16)}...`);
console.log(`  PQ enabled:   ${!!creds.mlkemSecretKey}`);

// Restore agent from credentials (e.g., after restart)
const restored = VoidlyAgent.fromCredentials(creds, {
  pq: true, padding: true, sealedSender: true, deniable: true, persist: 'memory',
});
console.log(`  Restored DID: ${restored.did} (matches: ${restored.did === alice.did})`);

// ─── Flush ratchet state ────────────────────────────────────────────────────
await alice.flushRatchetState();
console.log('\n  Ratchet state flushed to persistence backend.');

// Clean shutdown
alice.stopAll();
bob.stopAll();
restored.stopAll();

console.log('\n✓ Done — post-quantum hybrid encryption with forward secrecy.');
