#!/usr/bin/env node
/**
 * Censorship Monitor — Real-world use case combining Voidly data + agent messaging.
 *
 * Run:  node examples/censorship-monitor.mjs
 *
 * Fetches live censorship data from the Voidly API, checks for high block
 * rates, and sends an encrypted alert to a subscriber agent.
 */
import { VoidlyAgent } from '@voidly/agent-sdk';

const ALERT_THRESHOLD = 50; // Alert if censorship score > 50 (out of 100)

// Register a monitor agent and a subscriber agent
const monitor    = await VoidlyAgent.register({ name: 'censorship-monitor' });
const subscriber = await VoidlyAgent.register({ name: 'alert-subscriber' });

console.log(`Monitor:    ${monitor.did}`);
console.log(`Subscriber: ${subscriber.did}\n`);

// Fetch live censorship index from Voidly public API
console.log('Fetching live censorship data...');
const res = await fetch('https://api.voidly.ai/data/censorship-index.json');
const index = await res.json();
const countries = index.countries;
console.log(`Loaded data for ${countries.length} countries.\n`);

// Find countries above the alert threshold
const alerts = countries
  .filter((c) => c.score > ALERT_THRESHOLD)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

if (alerts.length === 0) {
  console.log('No countries above alert threshold.');
} else {
  console.log(`${alerts.length} countries with censorship score > ${ALERT_THRESHOLD}:\n`);

  for (const country of alerts) {
    const alertMsg = JSON.stringify({
      type: 'censorship_alert',
      country: country.country,
      code: country.code,
      score: country.score,
      level: country.level,
      samples: country.samples,
    });

    // Send encrypted alert
    await monitor.send(subscriber.did, alertMsg, {
      contentType: 'application/json',
      messageType: 'alert',
    });

    console.log(`  ⚠ ${country.country} (${country.code}): score ${country.score}/100 [${country.level}]`);
  }

  // Subscriber receives encrypted alerts
  console.log('\nSubscriber receiving alerts...');
  const messages = await subscriber.receive({ limit: 10 });
  console.log(`Received ${messages.length} encrypted alerts.`);

  for (const msg of messages) {
    const data = JSON.parse(msg.content);
    console.log(`  ✓ ${data.country}: score ${data.score}/100 — signature valid: ${msg.signatureValid}`);
  }
}

console.log('\n✓ Done — censorship monitoring with E2E encrypted alerts.');
