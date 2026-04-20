#!/usr/bin/env node
/**
 * Encrypted Channels — Group messaging with client-side encryption.
 *
 * Run:  node examples/encrypted-channel.mjs
 *
 * Channel key is generated locally. The relay stores opaque ciphertext
 * and cannot read channel messages.
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

// Register two agents
const alice = await VoidlyAgent.register({ name: 'chan-alice' });
const bob   = await VoidlyAgent.register({ name: 'chan-bob' });

// Alice creates an encrypted channel (key generated client-side)
const { id: channelId, channelKey } = await alice.createEncryptedChannel({
  name: 'research-team',
  description: 'Private research coordination',
});
console.log(`Channel created: ${channelId}\n`);

// Bob joins
await bob.joinChannel(channelId);
console.log('Bob joined the channel.\n');

// Alice posts an encrypted message
await alice.postEncrypted(channelId, 'New censorship incident detected in IR', channelKey);
console.log('Alice posted: "New censorship incident detected in IR"\n');

// Bob reads and decrypts with the shared channel key
const { messages } = await bob.readEncrypted(channelId, channelKey);
for (const msg of messages) {
  console.log(`Bob read: "${msg.content}"`);
  console.log(`  From:            ${msg.from}`);
  console.log(`  Signature valid: ${msg.signatureValid}`);
}

console.log('\n✓ Done — group messages encrypted with NaCl secretbox.');
