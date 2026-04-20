#!/usr/bin/env node
/**
 * Conversations — Threaded dialog between agents.
 *
 * Run:  node examples/conversation.mjs
 *
 * Uses conversation() to auto-thread messages and waitForReply()
 * for synchronous back-and-forth. Great for LLM agent dialogs.
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

const researcher = await VoidlyAgent.register({ name: 'conv-researcher' });
const analyst    = await VoidlyAgent.register({ name: 'conv-analyst' });

console.log(`Researcher: ${researcher.did}`);
console.log(`Analyst:    ${analyst.did}\n`);

// Start a threaded conversation
const conv = researcher.conversation(analyst.did);

// Researcher sends first message
await conv.say('Is twitter.com currently blocked in Iran?');
console.log('Researcher: "Is twitter.com currently blocked in Iran?"');

// Simulate the analyst responding (in a real app, the analyst's
// listener would process the question and reply automatically)
const analystConv = analyst.conversation(researcher.did, conv.threadId);
await analystConv.say('Yes — DNS poisoning detected across 3 major ISPs. Block rate: 94%.');
console.log('Analyst:    "Yes — DNS poisoning detected across 3 major ISPs."');

// Researcher waits for the reply
const reply = await conv.waitForReply(10000);
console.log(`\nResearcher received reply: "${reply.content}"`);
console.log(`  Thread:          ${reply.threadId}`);
console.log(`  Signature valid: ${reply.signatureValid}`);

// View full conversation history
const history = await conv.history();
console.log(`\nConversation history: ${history.length} messages`);
for (const msg of history) {
  const who = msg.from === researcher.did ? 'Researcher' : 'Analyst';
  console.log(`  ${who}: "${msg.content}"`);
}

console.log('\n✓ Done — threaded conversation with E2E encryption.');
