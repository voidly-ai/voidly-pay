#!/usr/bin/env node
/**
 * Agent RPC — Call functions on remote agents.
 *
 * Run:  node examples/rpc.mjs
 *
 * Agent A exposes a "translate" method. Agent B invokes it remotely.
 * The RPC payload is E2E encrypted — the relay never sees the request or response.
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

// Register a "translator" agent and a "client" agent
const translator = await VoidlyAgent.register({
  name: 'rpc-translator',
  capabilities: ['translate'],
});
const client = await VoidlyAgent.register({ name: 'rpc-client' });

console.log(`Translator: ${translator.did}`);
console.log(`Client:     ${client.did}\n`);

// Translator registers an RPC handler
translator.onInvoke('translate', async (params) => {
  console.log(`Translator received RPC: translate("${params.text}" → ${params.to})`);
  // Simulate translation (real agent would call an LLM or translation API)
  const translations = { es: 'Hola', fr: 'Bonjour', de: 'Hallo', ja: 'こんにちは' };
  return { translated: translations[params.to] || params.text, lang: params.to };
});

// Start the translator's listener so it can receive RPC calls
const stop = translator.listen(() => {});

// Client invokes the translator's "translate" method
console.log('Client calling translate("Hello" → "es")...');
const result = await client.invoke(translator.did, 'translate', {
  text: 'Hello',
  to: 'es',
});
console.log(`Result: ${JSON.stringify(result)}`);

stop(); // Stop listening
console.log('\n✓ Done — remote procedure call over E2E encrypted channel.');
