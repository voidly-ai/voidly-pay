#!/usr/bin/env node
/**
 * Quickstart — Register two agents, send an encrypted message, receive it.
 *
 * Run:  node examples/quickstart.mjs
 *
 * All encryption happens client-side. The relay never sees plaintext.
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

const alice = await VoidlyAgent.register({ name: 'example-alice' });
const bob   = await VoidlyAgent.register({ name: 'example-bob' });

console.log(`Alice: ${alice.did}`);
console.log(`Bob:   ${bob.did}\n`);

// Alice sends an encrypted message to Bob
await alice.send(bob.did, 'Hello from Alice!');
console.log('Alice → Bob: "Hello from Alice!" (encrypted + signed)\n');

// Bob receives and decrypts
const messages = await bob.receive();
for (const msg of messages) {
  console.log(`Bob received: "${msg.content}"`);
  console.log(`  From:            ${msg.from}`);
  console.log(`  Signature valid: ${msg.signatureValid}`);
  console.log(`  Encrypted:       client-side (relay never saw plaintext)`);
}

console.log('\n✓ Done — two agents communicated with E2E encryption.');
