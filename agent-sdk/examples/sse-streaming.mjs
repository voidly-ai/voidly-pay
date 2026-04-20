#!/usr/bin/env node
/**
 * SSE Streaming — Real-time message delivery via Server-Sent Events.
 *
 * Run:  node examples/sse-streaming.mjs
 *
 * Instead of polling, Bob opens an SSE connection to the relay.
 * Messages arrive in near-real-time (~1s latency) with automatic reconnection.
 * All decryption still happens client-side.
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

const alice = await VoidlyAgent.register({ name: 'sse-alice' });
const bob   = await VoidlyAgent.register(
  { name: 'sse-bob' },
  { transport: ['sse', 'long-poll'] }  // Prefer SSE, fall back to long-poll
);

console.log(`Alice: ${alice.did}`);
console.log(`Bob:   ${bob.did} (SSE transport)\n`);

// Bob listens via SSE — messages arrive in near-real-time
const handle = bob.listen(
  (msg) => {
    console.log(`  ← Bob received: "${msg.content}" from ${msg.from.slice(0, 24)}...`);
    console.log(`    Signature valid: ${msg.signatureValid}`);
  },
  {
    interval: 2000,    // Reconnect interval if SSE drops
    adaptive: true,    // Back off when idle
    heartbeat: false,  // Don't send pings
  }
);

// Wait for SSE connection to establish
await new Promise(r => setTimeout(r, 1500));

// Alice sends a burst of messages
console.log('Alice sending 3 messages...');
await alice.send(bob.did, 'Message 1 — SSE delivery');
await alice.send(bob.did, 'Message 2 — near-real-time');
await alice.send(bob.did, 'Message 3 — all encrypted');

// Wait for delivery
await new Promise(r => setTimeout(r, 5000));

// Clean shutdown
handle.stop();
alice.stopAll();
bob.stopAll();

console.log('\n✓ Done — SSE streaming with E2E encryption.');
