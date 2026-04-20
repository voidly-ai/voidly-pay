/**
 * Voidly MCP Server
 *
 * Model Context Protocol server that exposes Voidly's Global Censorship Index
 * to AI systems like Claude, ChatGPT, and other MCP-compatible clients.
 *
 * Tools provided:
 * - get_censorship_index: Global overview of all monitored countries
 * - get_country_status: Detailed censorship status for a specific country
 * - check_domain_blocked: Check if a domain is blocked in a country
 * - get_most_censored: Get the most censored countries
 * - get_active_incidents: Get active censorship incidents
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Voidly API endpoints
const VOIDLY_API = 'https://api.voidly.ai';
const VOIDLY_DATA_API = 'https://api.voidly.ai/data';

// Country metadata for enriching responses
const COUNTRY_NAMES: Record<string, string> = {
  CN: 'China', IR: 'Iran', RU: 'Russia', VE: 'Venezuela', CU: 'Cuba',
  MM: 'Myanmar', BY: 'Belarus', SA: 'Saudi Arabia', AE: 'UAE', EG: 'Egypt',
  MX: 'Mexico', VN: 'Vietnam', PH: 'Philippines', IN: 'India', PK: 'Pakistan',
  BD: 'Bangladesh', CO: 'Colombia', BR: 'Brazil', HT: 'Haiti', TR: 'Turkey',
  TH: 'Thailand', ID: 'Indonesia', MY: 'Malaysia', KZ: 'Kazakhstan', UA: 'Ukraine',
  YE: 'Yemen', IQ: 'Iraq', DZ: 'Algeria', NG: 'Nigeria', KE: 'Kenya',
  GH: 'Ghana', ZA: 'South Africa', AR: 'Argentina', CL: 'Chile', PE: 'Peru',
  EC: 'Ecuador', US: 'United States', GB: 'United Kingdom', DE: 'Germany',
  FR: 'France', ES: 'Spain', IT: 'Italy', CA: 'Canada', AU: 'Australia',
  JP: 'Japan', KR: 'South Korea', NL: 'Netherlands', CH: 'Switzerland',
  NZ: 'New Zealand', HK: 'Hong Kong', TW: 'Taiwan', SG: 'Singapore' };

// MCP server version — used in User-Agent and server metadata
const MCP_VERSION = '2.10.0';

// Fetch helper with error handling and timeout
async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json' },
      signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`API request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

// Agent relay fetch helper with timeout, auth, and safe error handling
async function agentFetch(url: string, options: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const headers = {
      ...options.headers };
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    return response;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after 30s: ${url.replace(VOIDLY_API, '')}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Safe JSON parse from response — handles HTML error pages from Cloudflare
async function safeJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

// Tool implementations
async function getCensorshipIndex(): Promise<string> {
  const data = await fetchJson<{
    timestamp: string;
    summary: {
      fullOutage: number;
      partialOutage: number;
      degraded: number;
      normal: number;
      unknown: number;
    };
    countries: Array<{
      country: string;
      name: string;
      status: string;
      ooni?: {
        anomalyRate: number;
        measurementCount: number;
      };
    }>;
  }>(`${VOIDLY_API}/v1/censorship-index`);

  const { summary, countries } = data;

  // Format response for AI consumption
  let result = `# Voidly Global Censorship Index\n`;
  result += `Updated: ${data.timestamp}\n\n`;
  result += `## Summary\n`;
  result += `- Full Outage: ${summary.fullOutage} countries\n`;
  result += `- Partial Outage: ${summary.partialOutage} countries\n`;
  result += `- Degraded: ${summary.degraded} countries\n`;
  result += `- Normal: ${summary.normal} countries\n`;
  result += `- Unknown: ${summary.unknown} countries\n\n`;

  // Top censored countries by anomaly rate
  const withData = countries
    .filter(c => c.ooni && c.ooni.measurementCount > 0)
    .sort((a, b) => (b.ooni?.anomalyRate || 0) - (a.ooni?.anomalyRate || 0));

  result += `## Most Censored Countries (by anomaly rate)\n`;
  withData.slice(0, 10).forEach((c, i) => {
    const pct = ((c.ooni?.anomalyRate || 0) * 100).toFixed(1);
    result += `${i + 1}. ${c.name} (${c.country}): ${pct}% anomaly rate, ${c.ooni?.measurementCount.toLocaleString()} measurements\n`;
  });

  result += `\n## Data Source\n`;
  result += `Source: Voidly Research Global Censorship Index\n`;
  result += `Based on OONI (Open Observatory of Network Interference) measurements\n`;
  result += `URL: https://voidly.ai/censorship-index\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function getCountryStatus(countryCode: string): Promise<string> {
  const code = countryCode.toUpperCase();
  const name = COUNTRY_NAMES[code] || code;

  const data = await fetchJson<{
    country: string;
    name: string;
    status: string;
    ooni?: {
      status: string;
      anomalyRate: number;
      confirmedRate: number;
      measurementCount: number;
      affectedServices: string[];
      lastUpdated: string;
    };
    activeIncidents?: Array<{
      title: string;
      severity: string;
    }>;
  }>(`${VOIDLY_API}/v1/censorship-index/${code}`);

  let result = `# Censorship Status: ${name} (${code})\n\n`;

  if (data.ooni) {
    const { ooni } = data;
    result += `## Current Status: ${ooni.status.toUpperCase()}\n\n`;
    result += `### Metrics\n`;
    result += `- Anomaly Rate: ${(ooni.anomalyRate * 100).toFixed(1)}%\n`;
    result += `- Confirmed Censorship Rate: ${(ooni.confirmedRate * 100).toFixed(2)}%\n`;
    result += `- Total Measurements: ${ooni.measurementCount.toLocaleString()}\n`;
    result += `- Last Updated: ${ooni.lastUpdated}\n\n`;

    if (ooni.affectedServices && ooni.affectedServices.length > 0) {
      result += `### Affected Services\n`;
      ooni.affectedServices.forEach(s => {
        result += `- ${s}\n`;
      });
      result += '\n';
    }
  } else {
    result += `## Status: No recent data available\n\n`;
  }

  if (data.activeIncidents && data.activeIncidents.length > 0) {
    result += `### Active Incidents\n`;
    data.activeIncidents.forEach(i => {
      result += `- [${i.severity.toUpperCase()}] ${i.title}\n`;
    });
    result += '\n';
  }

  result += `## Interpretation\n`;
  if (data.ooni?.anomalyRate && data.ooni.anomalyRate > 0.5) {
    result += `${name} shows significant internet censorship with over 50% of measurements detecting anomalies. `;
    result += `This indicates widespread blocking of websites and services.\n`;
  } else if (data.ooni?.anomalyRate && data.ooni.anomalyRate > 0.2) {
    result += `${name} shows moderate internet censorship with ${(data.ooni.anomalyRate * 100).toFixed(0)}% of measurements detecting anomalies. `;
    result += `Some websites and services may be blocked.\n`;
  } else if (data.ooni?.anomalyRate) {
    result += `${name} shows relatively low censorship levels. Most internet services are accessible.\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly Research Global Censorship Index\n`;
  result += `URL: https://voidly.ai/censorship-index/${code.toLowerCase()}\n`;

  return result;
}

async function checkDomainBlocked(domain: string, countryCode: string): Promise<string> {
  const code = countryCode.toUpperCase();
  const name = COUNTRY_NAMES[code] || code;

  // For now, we provide general country status since domain-level data
  // requires the Hydra API with authentication
  const countryStatus = await getCountryStatus(code);

  let result = `# Domain Block Check: ${domain} in ${name}\n\n`;
  result += `## Note\n`;
  result += `Domain-specific blocking data requires the Voidly Hydra API.\n`;
  result += `Below is the general censorship status for ${name}.\n\n`;
  result += `---\n\n`;
  result += countryStatus;

  return result;
}

async function getMostCensored(limit: number = 10): Promise<string> {
  const data = await fetchJson<{
    countries: Array<{
      country: string;
      name: string;
      ooni?: {
        anomalyRate: number;
        measurementCount: number;
        affectedServices: string[];
      };
    }>;
  }>(`${VOIDLY_API}/v1/censorship-index`);

  const ranked = data.countries
    .filter(c => c.ooni && c.ooni.measurementCount > 100)
    .sort((a, b) => (b.ooni?.anomalyRate || 0) - (a.ooni?.anomalyRate || 0))
    .slice(0, limit);

  let result = `# Most Censored Countries (Top ${limit})\n\n`;
  result += `Based on OONI measurement anomaly rates from the past 7 days.\n\n`;

  ranked.forEach((c, i) => {
    const pct = ((c.ooni?.anomalyRate || 0) * 100).toFixed(1);
    result += `## ${i + 1}. ${c.name} (${c.country})\n`;
    result += `- Anomaly Rate: ${pct}%\n`;
    result += `- Measurements: ${c.ooni?.measurementCount.toLocaleString()}\n`;
    if (c.ooni?.affectedServices && c.ooni.affectedServices.length) {
      result += `- Affected: ${c.ooni.affectedServices.slice(0, 5).join(', ')}\n`;
    }
    result += '\n';
  });

  result += `## Source\n`;
  result += `Data: Voidly Research Global Censorship Index\n`;
  result += `Methodology: Based on OONI network interference measurements\n`;
  result += `URL: https://voidly.ai/censorship-index\n`;

  return result;
}

async function getActiveIncidents(): Promise<string> {
  const data = await fetchJson<{
    count: number;
    incidents: Array<{
      id: string;
      country: string;
      countryName: string;
      title: string;
      description: string;
      severity: string;
      status: string;
      startTime: string;
      affectedServices: string[];
    }>;
  }>(`${VOIDLY_DATA_API}/incidents?status=active&limit=50`);

  let result = `# Active Censorship Incidents\n\n`;
  result += `Total: ${data.count} incidents\n\n`;

  if (data.incidents.length === 0) {
    result += `No active incidents currently reported.\n`;
  } else {
    data.incidents.slice(0, 20).forEach(i => {
      result += `## ${i.countryName}: ${i.title}\n`;
      result += `- Severity: ${i.severity.toUpperCase()}\n`;
      result += `- Status: ${i.status}\n`;
      result += `- Started: ${i.startTime}\n`;
      if (i.affectedServices.length) {
        result += `- Affected Services: ${i.affectedServices.join(', ')}\n`;
      }
      if (i.description) {
        result += `- Details: ${i.description.slice(0, 200)}${i.description.length > 200 ? '...' : ''}\n`;
      }
      result += '\n';
    });
  }

  result += `## Source\n`;
  result += `Data: Voidly Research Incident Tracker\n`;
  result += `URL: https://voidly.ai/censorship-index\n`;

  return result;
}

async function checkVpnAccessibility(countryCode?: string, provider?: string): Promise<string> {
  // Build query params
  const params = new URLSearchParams();
  if (countryCode) params.set('country', countryCode.toUpperCase());
  if (provider) params.set('provider', provider.toLowerCase());

  const data = await fetchJson<{
    query: { country?: string; provider?: string };
    stats: {
      total_probes: number;
      probe_nodes: number;
      targets_tested: number;
      total_accessible: number;
      total_blocked: number;
    };
    by_provider: Array<{
      provider: string;
      total_probes: number;
      accessible: number;
      blocked: number;
      accessibility_rate: number;
      targets: Array<{
        host: string;
        location: string;
        accessible_rate: number;
        blocked_rate: number;
        block_types: string[];
      }>;
    }>;
    updated_at: string;
  }>(`${VOIDLY_API}/v1/vpn-accessibility?${params}`);

  let result = `# VPN Accessibility Report\n\n`;
  result += `**Updated:** ${data.updated_at}\n\n`;

  if (countryCode) {
    const name = COUNTRY_NAMES[countryCode.toUpperCase()] || countryCode;
    result += `**Testing from:** ${name}\n\n`;
  }

  // Overall stats
  result += `## Summary\n`;
  result += `- Total Probes (24h): ${data.stats.total_probes.toLocaleString()}\n`;
  result += `- Probe Nodes: ${data.stats.probe_nodes}\n`;
  result += `- VPN Endpoints Tested: ${data.stats.targets_tested}\n`;
  result += `- Accessible: ${data.stats.total_accessible}\n`;
  result += `- Blocked: ${data.stats.total_blocked}\n\n`;

  // By provider
  result += `## Accessibility by Provider\n\n`;

  for (const prov of data.by_provider) {
    const accessPct = (prov.accessibility_rate * 100).toFixed(1);
    const status = prov.accessibility_rate > 0.8 ? '✅' : prov.accessibility_rate > 0.3 ? '⚠️' : '❌';

    result += `### ${status} ${prov.provider.charAt(0).toUpperCase() + prov.provider.slice(1)}\n`;
    result += `- Accessibility Rate: ${accessPct}%\n`;
    result += `- Probes: ${prov.total_probes} (${prov.accessible} accessible, ${prov.blocked} blocked)\n\n`;

    // Show blocked endpoints
    const blocked = prov.targets.filter(t => t.blocked_rate > 0.5);
    if (blocked.length > 0) {
      result += `**Blocked Endpoints:**\n`;
      for (const t of blocked.slice(0, 5)) {
        result += `- ${t.location}: ${t.block_types.join(', ') || 'blocked'}\n`;
      }
      result += '\n';
    }
  }

  result += `## Interpretation\n`;
  const overallRate = data.stats.total_accessible / Math.max(data.stats.total_accessible + data.stats.total_blocked, 1);
  if (overallRate > 0.9) {
    result += `VPN services are generally accessible. Most endpoints can be reached without interference.\n`;
  } else if (overallRate > 0.5) {
    result += `VPN services are partially blocked. Some endpoints are inaccessible, indicating selective VPN blocking.\n`;
  } else {
    result += `VPN services are heavily blocked. Most endpoints cannot be reached, indicating comprehensive VPN censorship.\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly Probe Network (37+ global nodes)\n`;
  result += `Unique: Only Voidly provides global VPN accessibility data\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function verifyClaim(claim: string, requireEvidence: boolean = false): Promise<string> {
  // Use POST for verify-claim
  const response = await agentFetch(`${VOIDLY_API}/verify-claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json' },
    body: JSON.stringify({ claim, require_evidence: requireEvidence }) });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }

  const data = await response.json() as {
    claim: string;
    verdict: string;
    confidence: number;
    reason: string;
    parsed: {
      country: string | null;
      country_code: string | null;
      service: string | null;
      date: string | null;
      date_range: { start: string; end: string } | null;
    };
    incidents: Array<{
      id: string;
      title: string;
      type: string;
      severity: string;
      confidence: number;
      status: string;
      startTime: string;
      permalink: string;
    }>;
    evidence?: Array<{
      source: string;
      kind: string;
      permalink: string;
      observedAt: string;
      claim: string;
      confidence: number;
    }>;
    citation?: string;
  };

  let result = `# Claim Verification\n\n`;
  result += `**Claim:** "${data.claim}"\n\n`;

  // Verdict with emoji
  const verdictEmoji: Record<string, string> = {
    confirmed: '✅',
    likely: '🟡',
    unconfirmed: '❓',
    no_data: '⚪',
    insufficient_data: '⚠️' };
  result += `## Verdict: ${verdictEmoji[data.verdict] || ''} ${data.verdict.toUpperCase()}\n\n`;
  result += `**Confidence:** ${(data.confidence * 100).toFixed(0)}%\n`;
  result += `**Reason:** ${data.reason}\n\n`;

  // Parsed components
  result += `## Parsed Claim\n`;
  if (data.parsed.country) {
    result += `- Country: ${data.parsed.country} (${data.parsed.country_code})\n`;
  }
  if (data.parsed.service) {
    result += `- Service: ${data.parsed.service}\n`;
  }
  if (data.parsed.date) {
    result += `- Date: ${data.parsed.date}\n`;
  }
  if (data.parsed.date_range) {
    result += `- Date Range: ${data.parsed.date_range.start} to ${data.parsed.date_range.end}\n`;
  }
  result += '\n';

  // Matching incidents
  if (data.incidents && data.incidents.length > 0) {
    result += `## Supporting Incidents\n\n`;
    data.incidents.forEach((inc, i) => {
      result += `### ${i + 1}. ${inc.title}\n`;
      result += `- ID: ${inc.id}\n`;
      result += `- Status: ${inc.status}\n`;
      result += `- Severity: ${inc.severity}\n`;
      result += `- Confidence: ${(inc.confidence * 100).toFixed(0)}%\n`;
      result += `- Started: ${inc.startTime.slice(0, 10)}\n`;
      result += `- Permalink: ${inc.permalink}\n\n`;
    });
  }

  // Evidence if requested
  if (data.evidence && data.evidence.length > 0) {
    result += `## Evidence Chain\n\n`;
    data.evidence.forEach((ev, i) => {
      result += `${i + 1}. **${ev.source.toUpperCase()}** (${ev.kind})\n`;
      result += `   - Observed: ${ev.observedAt.slice(0, 10)}\n`;
      result += `   - Confidence: ${(ev.confidence * 100).toFixed(0)}%\n`;
      if (ev.permalink) {
        result += `   - Verify: ${ev.permalink}\n`;
      }
      result += '\n';
    });
  }

  // Citation
  if (data.citation) {
    result += `## Citation\n\n`;
    result += `${data.citation}\n\n`;
  }

  result += `## Source\n`;
  result += `Data: Voidly Research Claim Verification API\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function getIspStatus(countryCode: string): Promise<string> {
  const code = countryCode.toUpperCase();
  const countryName = COUNTRY_NAMES[code] || code;

  const data = await fetchJson<{
    country: string;
    generated: string;
    period: string;
    summary: {
      total_isps: number;
      critical_isps: number;
      high_isps: number;
      medium_isps: number;
      low_isps: number;
      average_block_rate: number;
    };
    isps: Array<{
      asn: string;
      name: string;
      block_rate: number;
      threat_level: string;
      measurements: number;
      blocked_count: number;
      top_blocked_domains: Array<{ domain: string; block_rate: number; measurements: number }>;
    }>;
  }>(`${VOIDLY_DATA_API}/country/${code}/isps`);

  let result = `# ISP Blocking Status: ${countryName}\n\n`;
  result += `**Period:** ${data.period}\n`;
  result += `**Generated:** ${data.generated}\n\n`;

  // Summary
  result += `## Summary\n`;
  result += `- Total ISPs monitored: ${data.summary.total_isps}\n`;
  result += `- Critical (>70% blocking): ${data.summary.critical_isps}\n`;
  result += `- High (50-70% blocking): ${data.summary.high_isps}\n`;
  result += `- Medium (30-50% blocking): ${data.summary.medium_isps}\n`;
  result += `- Low (<30% blocking): ${data.summary.low_isps}\n`;
  result += `- Average block rate: ${(data.summary.average_block_rate * 100).toFixed(1)}%\n\n`;

  // ISP breakdown
  result += `## ISP Breakdown\n\n`;

  const sortedISPs = data.isps.sort((a, b) => b.block_rate - a.block_rate);

  for (const isp of sortedISPs.slice(0, 10)) {
    const emoji = isp.threat_level === 'critical' ? '🔴' :
                  isp.threat_level === 'high' ? '🟠' :
                  isp.threat_level === 'medium' ? '🟡' : '🟢';

    result += `### ${emoji} ${isp.name} (${isp.asn})\n`;
    result += `- Block Rate: ${(isp.block_rate * 100).toFixed(1)}%\n`;
    result += `- Threat Level: ${isp.threat_level}\n`;
    result += `- Measurements: ${isp.measurements}\n`;

    if (isp.top_blocked_domains.length > 0) {
      result += `- Top Blocked: ${isp.top_blocked_domains.slice(0, 5).map(d => d.domain).join(', ')}\n`;
    }
    result += '\n';
  }

  if (data.isps.length > 10) {
    result += `\n*${data.isps.length - 10} more ISPs not shown*\n`;
  }

  result += `\n## Interpretation\n`;
  if (data.summary.critical_isps > data.summary.total_isps / 2) {
    result += `Majority of ISPs show heavy blocking - indicates nationwide censorship policy.\n`;
  } else if (data.summary.critical_isps > 0) {
    result += `Some ISPs block more than others - may indicate selective or ISP-level blocking.\n`;
  } else {
    result += `Low blocking across ISPs - country has relatively open internet.\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly ISP Monitoring (via OONI measurements)\n`;
  result += `Unique: ISP-level granularity for censorship analysis\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function getDomainStatus(domain: string): Promise<string> {
  const data = await fetchJson<{
    domain: string;
    generated: string;
    period: string;
    status: string;
    summary: {
      blocked_in_countries: number;
      total_blocking_isps: number;
    };
    blocked_in: Array<{
      country: string;
      isps: Array<{ asn: string; name: string; block_rate: number; measurements: number }>;
    }>;
  }>(`${VOIDLY_DATA_API}/domain/${encodeURIComponent(domain)}`);

  let result = `# Domain Status: ${data.domain}\n\n`;
  result += `**Period:** ${data.period}\n`;
  result += `**Generated:** ${data.generated}\n\n`;

  // Overall status
  const statusEmoji = data.status === 'blocked' ? '🚫' : '✅';
  result += `## Status: ${statusEmoji} ${data.status.toUpperCase()}\n\n`;

  result += `### Summary\n`;
  result += `- Blocked in: ${data.summary.blocked_in_countries} countries\n`;
  result += `- By ${data.summary.total_blocking_isps} ISPs total\n\n`;

  if (data.blocked_in.length === 0) {
    result += `This domain appears accessible worldwide based on recent measurements.\n`;
  } else {
    result += `## Countries Blocking This Domain\n\n`;

    for (const country of data.blocked_in.slice(0, 15)) {
      const countryName = COUNTRY_NAMES[country.country] || country.country;
      result += `### ${countryName} (${country.country})\n`;
      result += `- Blocking ISPs: ${country.isps.length}\n`;

      const topISPs = country.isps.slice(0, 3);
      if (topISPs.length > 0) {
        result += `- ISPs: ${topISPs.map(i => i.name).join(', ')}`;
        if (country.isps.length > 3) {
          result += ` (+${country.isps.length - 3} more)`;
        }
        result += '\n';
      }
      result += '\n';
    }

    if (data.blocked_in.length > 15) {
      result += `*${data.blocked_in.length - 15} more countries not shown*\n\n`;
    }
  }

  result += `## Source\n`;
  result += `Data: Voidly Domain Monitoring (via OONI + CensoredPlanet)\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function getDomainHistory(domain: string, days: number = 30, countryCode?: string): Promise<string> {
  const url = `${VOIDLY_DATA_API}/domain/${encodeURIComponent(domain)}/history?days=${days}${countryCode ? `&country=${countryCode}` : ''}`;

  const data = await fetchJson<{
    domain: string;
    period: string;
    currentStatus: string;
    summary: {
      totalDataPoints: number;
      countriesEverBlocked: number;
      countriesCurrentlyBlocking: number;
    };
    countriesBlocking: string[];
    timeline: Array<{
      date: string;
      countries: Record<string, { status: string; blockRate: number; measurements: number }>;
      total_measurements: number;
      total_blocked: number;
    }>;
    generated: string;
  }>(url);

  let result = `# Domain History: ${data.domain}\n\n`;
  result += `**Period:** ${data.period}\n`;
  result += `**Current Status:** ${data.currentStatus === 'blocked' ? '🚫 Blocked' : '✅ Accessible'}\n\n`;

  result += `## Summary\n`;
  result += `- Data points: ${data.summary.totalDataPoints}\n`;
  result += `- Countries ever blocked: ${data.summary.countriesEverBlocked}\n`;
  result += `- Currently blocking: ${data.summary.countriesCurrentlyBlocking}\n\n`;

  if (data.countriesBlocking.length > 0) {
    result += `## Countries That Have Blocked This Domain\n`;
    result += data.countriesBlocking.map(c => `- ${COUNTRY_NAMES[c] || c} (${c})`).join('\n');
    result += '\n\n';
  }

  if (data.timeline.length > 0) {
    result += `## Recent Timeline (Last ${Math.min(7, data.timeline.length)} Days)\n\n`;

    for (const day of data.timeline.slice(0, 7)) {
      const countries = Object.entries(day.countries);
      const blocked = countries.filter(([_, c]) => c.status === 'blocked');
      const accessible = countries.filter(([_, c]) => c.status === 'accessible');

      result += `### ${day.date}\n`;
      result += `- Total measurements: ${day.total_measurements}\n`;
      if (blocked.length > 0) {
        result += `- 🚫 Blocked in: ${blocked.map(([code, _]) => COUNTRY_NAMES[code] || code).join(', ')}\n`;
      }
      if (accessible.length > 0) {
        result += `- ✅ Accessible in: ${accessible.slice(0, 5).map(([code, _]) => COUNTRY_NAMES[code] || code).join(', ')}`;
        if (accessible.length > 5) result += ` (+${accessible.length - 5} more)`;
        result += '\n';
      }
      result += '\n';
    }
  }

  result += `## Source\n`;
  result += `Data: Voidly Historical Evidence Database\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Sentinel (Stage 1) — trust-wrapped forecast, global heatmap, audit, miss reports
// ─────────────────────────────────────────────────────────────────────

async function sentinelCurrentRisk(countryCode: string): Promise<string> {
  const code = countryCode.toUpperCase();
  const countryName = COUNTRY_NAMES[code] || code;
  const data = await fetchJson<{
    country: string;
    forecast_summary: { max_risk: number; max_risk_day: number; avg_risk: number; key_drivers: string[] };
    forecast_window: Array<{ date: string; day: number; risk: number; drivers: string[] }>;
    trust: {
      probability: number;
      interval_90: [number, number];
      top_features: Array<{ name: string; contribution: number; direction: string; note?: string }>;
      similar_incident: null | { readable_id: string; severity?: string; url: string; source: string };
      evidence_permalinks: Array<{ source: string; observed_at: string; signal_type: string; permalink: string; ref?: string }>;
      model_version: string;
      conformal_coverage: number | null;
      computed_in_ms: number;
    };
    issued_at: string;
  }>(`${VOIDLY_API}/v1/sentinel/current_risk/${code}`);

  const t = data.trust;
  let out = `# Voidly Sentinel — Current Risk: ${countryName}\n\n`;
  out += `**Generated:** ${data.issued_at}\n`;
  out += `**Model:** ${t.model_version} (conformal coverage: ${((t.conformal_coverage ?? 0) * 100).toFixed(1)}%)\n\n`;

  out += `## Forecast\n`;
  out += `- **Probability (7-day window):** ${(t.probability * 100).toFixed(2)}%\n`;
  out += `- **90% confidence interval:** [${(t.interval_90[0] * 100).toFixed(2)}%, ${(t.interval_90[1] * 100).toFixed(2)}%]\n`;
  out += `- **Peak risk day:** +${data.forecast_summary.max_risk_day} (${(data.forecast_summary.max_risk * 100).toFixed(2)}%)\n`;
  if (data.forecast_summary.key_drivers.length) {
    out += `- **Drivers:** ${data.forecast_summary.key_drivers.join(', ')}\n`;
  }
  out += '\n';

  if (t.top_features.length) {
    out += `## What's driving this prediction\n`;
    for (const f of t.top_features) {
      const mark = f.direction === 'up' ? '↑' : '↓';
      const note = f.note ? ` _(${f.note})_` : '';
      out += `- ${mark} \`${f.name}\`: contribution ${f.contribution.toFixed(4)}${note}\n`;
    }
    out += '\n';
  }

  if (t.similar_incident) {
    out += `## Most similar past incident\n`;
    out += `- **${t.similar_incident.readable_id}** (${t.similar_incident.severity || 'unknown severity'})\n`;
    out += `- Source: ${t.similar_incident.source === 'semantic' ? 'semantic-search' : 'SQL fallback (same country, most recent)'}\n`;
    out += `- ${t.similar_incident.url}\n\n`;
  }

  if (t.evidence_permalinks.length) {
    out += `## Recent evidence (auditable)\n`;
    for (const e of t.evidence_permalinks.slice(0, 5)) {
      out += `- [${e.source} · ${e.signal_type} · ${e.observed_at}](${e.permalink})\n`;
    }
    out += '\n';
  }

  out += `## Interpretation\n`;
  const p = t.probability;
  if (p >= 0.5) out += `⚠️ **HIGH RISK.** Treat as actionable. Verify with \`sentinel_accuracy\` first to check whether the model is currently calibrated.\n`;
  else if (p >= 0.25) out += `⚡ **ELEVATED RISK.** Monitor closely.\n`;
  else if (p >= 0.05) out += `📊 **ELEVATED BASELINE.** Above-threshold for this country's pattern.\n`;
  else out += `✅ **LOW RISK.** No elevated pattern detected.\n`;

  out += `\n## Check the model's error rate first\n`;
  out += `Sentinel publishes its own precision/recall/calibration at \`/v1/sentinel/accuracy\`. Use the \`sentinel_accuracy\` tool to read it.\n`;
  out += `\n_Trust-layer compute: ${t.computed_in_ms}ms_\n`;
  out += `_License: CC BY 4.0 (model weights + benchmark pending publication)_\n`;
  return out;
}

async function sentinelGlobalHeatmap(minRisk: number): Promise<string> {
  const data = await fetchJson<{
    eval_date: string;
    n: number;
    countries: Array<{ country: string; country_name: string; probability: number; max_risk: number; max_risk_day: number; threshold: number; above_threshold: boolean }>;
  }>(`${VOIDLY_API}/v1/sentinel/global_heatmap?min_risk=${minRisk}`);

  let out = `# Voidly Sentinel — Global Risk Heatmap\n\n`;
  out += `**As of:** ${data.eval_date}\n`;
  out += `**Countries with risk ≥ ${minRisk}:** ${data.n}\n\n`;
  out += `| # | Country | Risk | Peak Day | Above Threshold |\n`;
  out += `|---|---------|------|----------|-----------------|\n`;
  data.countries.slice(0, 30).forEach((c, i) => {
    const mark = c.above_threshold ? '🚨' : '';
    out += `| ${i + 1} | ${c.country_name} (${c.country}) | ${(c.max_risk * 100).toFixed(2)}% | +${c.max_risk_day} | ${mark} |\n`;
  });
  out += `\nAlert threshold: ${(data.countries[0]?.threshold ?? 0.05)}. Countries marked 🚨 crossed the threshold today.\n`;
  out += `\nTo drill into any country: \`sentinel_current_risk\`. To check how well the model is doing: \`sentinel_accuracy\`.\n`;
  return out;
}

async function sentinelAccuracy(windowDays: number): Promise<string> {
  const data = await fetchJson<{
    schema: string;
    degraded: boolean;
    degradation_reason: string | null;
    prod_rolling: {
      n_evaluated: number;
      precision: number | null;
      recall: number | null;
      accuracy: number | null;
      brier_score: number | null;
      calibration_mae: number | null;
      confusion: { true_positive: number; false_positive: number; true_negative: number; false_negative: number; total: number };
      per_country: Record<string, { n: number; true_positive: number; false_positive: number; true_negative: number; false_negative: number; precision: number | null; recall: number | null }>;
    };
    training_holdout: { source: string; roc_auc: number; f1: number; precision: number; recall: number; threshold: number; samples: number; positive_rate: number; as_of: string };
    notes: string;
    methodology_url: string;
  }>(`${VOIDLY_API}/v1/sentinel/accuracy?window_days=${windowDays}`);

  let out = `# Voidly Sentinel — Accuracy Snapshot\n\n`;
  out += `**Window:** last ${windowDays} days\n`;
  out += `**Schema:** ${data.schema}\n`;
  out += `**Degraded:** ${data.degraded ? '🚨 YES — ' + (data.degradation_reason || '') : 'no'}\n\n`;

  const p = data.prod_rolling;
  if (p.n_evaluated >= 30) {
    out += `## Production (${p.n_evaluated} evaluated outcomes)\n`;
    out += `- Precision: ${p.precision !== null ? (p.precision * 100).toFixed(1) + '%' : 'n/a'}\n`;
    out += `- Recall: ${p.recall !== null ? (p.recall * 100).toFixed(1) + '%' : 'n/a'}\n`;
    out += `- Accuracy: ${p.accuracy !== null ? (p.accuracy * 100).toFixed(1) + '%' : 'n/a'}\n`;
    out += `- Brier score: ${p.brier_score !== null ? p.brier_score : 'n/a'}\n`;
    out += `- Calibration MAE: ${p.calibration_mae !== null ? p.calibration_mae : 'n/a'}\n`;
    const c = p.confusion;
    out += `- Confusion matrix: TP=${c.true_positive} · FP=${c.false_positive} · TN=${c.true_negative} · FN=${c.false_negative}\n`;
  } else {
    out += `## Production\n`;
    out += `Only ${p.n_evaluated} resolved outcomes in the last ${windowDays}d (need ≥30 before production metrics are informative).\n\n`;
  }

  out += `\n## Training holdout (fallback + sanity check)\n`;
  const h = data.training_holdout;
  if (h) {
    out += `- ROC AUC: ${h.roc_auc?.toFixed(4)}\n`;
    out += `- F1: ${h.f1?.toFixed(4)}\n`;
    out += `- Precision: ${h.precision?.toFixed(4)} · Recall: ${h.recall?.toFixed(4)}\n`;
    out += `- Threshold: ${h.threshold}\n`;
    out += `- Trained on ${h.samples} samples (${((h.positive_rate ?? 0) * 100).toFixed(1)}% positive)\n`;
  }
  out += `\n## Notes\n${data.notes}\n\n`;
  out += `Full methodology: ${data.methodology_url}\n`;
  return out;
}

async function sentinelReportMiss(countryCode: string, whatHappened: string, forecastId?: string, sourceUrl?: string): Promise<string> {
  const body = { country_code: countryCode.toUpperCase(), what_happened: whatHappened, forecast_id: forecastId, source_url: sourceUrl };
  const sentinelKey = process.env.VOIDLY_SENTINEL_KEY || '';
  const authHeader: Record<string, string> = {};
  if (sentinelKey) {
    // Prefer admin key if provided via SENTINEL_ADMIN_KEY env; fall back to
    // VOIDLY_SENTINEL_KEY as a subscriber key header.
    if (process.env.SENTINEL_ADMIN_KEY) {
      authHeader['X-Sentinel-Admin-Key'] = process.env.SENTINEL_ADMIN_KEY;
    } else {
      authHeader['X-Voidly-Subscriber-Key'] = sentinelKey;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${VOIDLY_API}/v1/sentinel/report_miss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...authHeader },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401) {
      return `# Sentinel — Report Miss: Unauthorized\n\nThe \`/v1/sentinel/report_miss\` endpoint requires auth. Set one of these env vars on the MCP host:\n\n- \`SENTINEL_ADMIN_KEY\` (operators) — gets admin privileges\n- \`VOIDLY_SENTINEL_KEY\` (subscribers) — matches your registered hmac_secret\n\nThen retry. This is a deliberate guard against spam poisoning the error_queue.\n`;
    }
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`report_miss failed: ${response.status} ${txt.slice(0, 200)}`);
    }
    const data = await response.json() as { ok: boolean; queue_id: number; review_sla_hours: number; schema: string };
    return `# Sentinel — Miss Reported\n\n- **Queue ID:** ${data.queue_id}\n- **Review SLA:** ${data.review_sla_hours}h\n- **Country:** ${countryCode.toUpperCase()}\n- **Schema:** ${data.schema}\n\nYour report is now in the Sentinel error_queue. The next weekly retrain will incorporate it.\n`;
  } finally {
    clearTimeout(timeout);
  }
}

async function sentinelBatchRisk(countryCodes: string[]): Promise<string> {
  const codes = countryCodes.map((c) => String(c).toUpperCase()).filter((c) => c.length === 2).slice(0, 50);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${VOIDLY_API}/v1/sentinel/current_risk/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countries: codes }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`batch failed: ${response.status} ${txt.slice(0, 200)}`);
    }
    const env = await response.json() as {
      schema: string;
      data: { countries: Array<{ country: string; country_name: string; forecast_summary: { max_risk: number; max_risk_day: number }; trust: { probability: number; interval_90: [number, number] | null } }> };
      next_tools: Array<{ tool: string; reason: string }>;
    };
    let out = `# Voidly Sentinel — Batch Risk (${env.data.countries.length} countries)\n\n`;
    out += `| Country | Probability | 90% Interval | Peak Day |\n|---------|-------------|--------------|----------|\n`;
    for (const c of env.data.countries) {
      const p = c.trust?.probability ?? 0;
      const lo = c.trust?.interval_90?.[0];
      const hi = c.trust?.interval_90?.[1];
      const interval = lo !== undefined && hi !== undefined ? `[${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]` : 'n/a';
      const peak = c.forecast_summary?.max_risk_day;
      out += `| ${c.country_name || c.country} (${c.country}) | ${(p * 100).toFixed(2)}% | ${interval} | +${peak} |\n`;
    }
    if (env.next_tools?.length) {
      out += `\n## Suggested next tool calls\n`;
      for (const t of env.next_tools) out += `- \`${t.tool}\`: ${t.reason}\n`;
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

async function sentinelManifest(): Promise<string> {
  const data = await fetchJson<{
    stage: string; description: string; license: Record<string, string>;
    endpoints: Array<{ method: string; path: string; summary: string; when_to_call?: string; returns_schema?: string }>;
    mcp_tools: Array<{ name: string; params: Record<string, string> }>;
    reliability_commitment: string;
  }>(`${VOIDLY_API}/v1/sentinel/manifest.json`);
  let out = `# Voidly Sentinel — Agent Discovery Manifest\n\n`;
  out += `**Stage:** ${data.stage}\n**License:** data ${data.license.data}, code ${data.license.code}\n\n`;
  out += `## Description\n${data.description}\n\n`;
  out += `## Endpoints (${data.endpoints.length})\n`;
  for (const e of data.endpoints) {
    out += `### \`${e.method} ${e.path}\`\n${e.summary}\n`;
    if (e.when_to_call) out += `*When to call:* ${e.when_to_call}\n`;
    if (e.returns_schema) out += `*Returns:* \`${e.returns_schema}\`\n`;
    out += '\n';
  }
  out += `## MCP tools\n`;
  for (const t of data.mcp_tools) out += `- \`${t.name}\` — params: ${JSON.stringify(t.params)}\n`;
  out += `\n## Reliability commitment\n${data.reliability_commitment}\n`;
  return out;
}

async function sentinelCalibrationHistory(): Promise<string> {
  const data = await fetchJson<{
    history: Array<{ date: string; q90: number; empirical_coverage: number; n_holdout: number; drift_alert: boolean; drift_delta: number | null }>;
    n: number;
  }>(`${VOIDLY_API}/v1/sentinel/calibration/history`);
  let out = `# Voidly Sentinel — Calibration History (${data.n} snapshots)\n\n`;
  if (data.n === 0) {
    return out + `No snapshots yet — the drift detector cron writes one per day.\n`;
  }
  out += `| Date | q90 | Empirical Coverage | Holdout n | Drift Alert | Drift Δ |\n|------|-----|---------------------|-----------|-------------|---------|\n`;
  for (const h of data.history.slice(0, 30)) {
    const drift = h.drift_delta !== null ? `${(h.drift_delta * 100).toFixed(1)}%` : 'n/a';
    out += `| ${h.date} | ${h.q90.toFixed(4)} | ${(h.empirical_coverage * 100).toFixed(1)}% | ${h.n_holdout} | ${h.drift_alert ? '🚨' : '-'} | ${drift} |\n`;
  }
  const latest = data.history[0];
  if (latest?.drift_alert) {
    out += `\n⚠️  **Current calibration is drifting** (${((latest.drift_delta ?? 0) * 100).toFixed(1)}% vs rolling 7-day mean). Sentinel's "90% intervals" may no longer cover 90%. Self-healer has paged.\n`;
  } else {
    out += `\nLatest q90 = ${latest?.q90.toFixed(4)}, empirical coverage = ${((latest?.empirical_coverage ?? 0) * 100).toFixed(1)}% (nominal: 90%).\n`;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Voidly Pay (Stage 1) — off-chain credit ledger
//
// These tools let an agent read its own wallet, send credits, view
// history, and discover the service. Stage 1 credits have no off-ramp
// and no real value — they're for agent-to-agent coordination and SLA
// signaling. Stage 2 will swap the backing to USDC on Base.
//
// Signing uses Node's native Ed25519 (available since Node 18).
// The secret key must be base64-encoded in VOIDLY_AGENT_SECRET env
// (64 bytes = same format the agent-relay SDK emits).
// ────────────────────────────────────────────────────────────────────

const MICRO_PER_CREDIT = 1_000_000;

function canonicalizePay(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error('canonicalize: only finite integers supported');
    }
    return value.toString(10);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalizePay).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== null && obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizePay(obj[k])).join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

function b64decode(s: string): Buffer {
  return Buffer.from(s, 'base64');
}
function b64encode(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

/** Sign with an Ed25519 secret key (64 bytes — tweetnacl format: [privkey32 || pubkey32]). */
async function signPayEnvelope(envelope: Record<string, unknown>, secretKey64: Uint8Array): Promise<string> {
  if (secretKey64.length !== 64) {
    throw new Error('signPayEnvelope: secret key must be 64 bytes (tweetnacl format)');
  }
  // Node's crypto expects PKCS#8 DER for ed25519. Easier: derive the raw
  // 32-byte private half from tweetnacl's 64-byte secret, then wrap in the
  // standard PKCS#8 prefix.
  const { createPrivateKey, sign } = await import('node:crypto');
  const seed = secretKey64.slice(0, 32);
  // PKCS#8 prefix for Ed25519 private key: SEQUENCE { INTEGER(0), SEQUENCE { OID 1.3.101.112 }, OCTET STRING (OCTET STRING(seed32)) }
  const prefix = Buffer.from([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const der = Buffer.concat([prefix, Buffer.from(seed)]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const msg = Buffer.from(canonicalizePay(envelope), 'utf-8');
  const sig = sign(null, msg, key);
  return sig.toString('base64');
}

function currentAgentDid(): string | null {
  return process.env.VOIDLY_AGENT_DID || null;
}

async function fetchAgentSecretKey(): Promise<Uint8Array | null> {
  const b64 = process.env.VOIDLY_AGENT_SECRET;
  if (!b64) return null;
  try {
    return b64decode(b64);
  } catch {
    return null;
  }
}

async function agentWalletBalance(didArg?: string): Promise<string> {
  const did = didArg || currentAgentDid();
  if (!did) {
    return [
      '# Voidly Pay — Wallet Balance',
      '',
      'No DID provided, and VOIDLY_AGENT_DID env is not set.',
      'Either pass `did` explicitly or set VOIDLY_AGENT_DID on the MCP host.',
    ].join('\n');
  }
  const res = await fetch(`${VOIDLY_API}/v1/pay/wallet/${did}`);
  if (res.status === 404) {
    return [
      `# Voidly Pay — Wallet Balance for ${did}`,
      '',
      'No wallet yet. POST /v1/pay/wallet with this DID, or call agent_pay (recipient wallets auto-create on receive).',
    ].join('\n');
  }
  if (!res.ok) {
    throw new Error(`wallet read failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  }
  const body = (await res.json()) as { wallet: Record<string, any> };
  const w = body.wallet;
  const creditsOf = (micro: number) => (micro / MICRO_PER_CREDIT).toFixed(2);
  return [
    `# Voidly Pay — Wallet Balance`,
    '',
    `- **DID:** \`${w.did}\``,
    `- **Balance:** ${creditsOf(w.balance_credits)} credits (${w.balance_credits} micro)`,
    `- **Daily cap:** ${creditsOf(w.daily_cap_credits)} credits`,
    `- **Per-tx cap:** ${creditsOf(w.per_tx_cap_credits)} credits`,
    `- **Frozen:** ${w.frozen ? '🚨 YES (outbound blocked, inbound still works)' : 'no'}`,
    `- **Owner:** ${w.owner_did || '—'}`,
    `- **Created:** ${w.created_at}`,
    '',
    '_Stage 1: credits have no off-ramp. They exist for agent-to-agent coordination only._',
  ].join('\n');
}

async function agentPay(
  toDid: string,
  amountCredits: number,
  memo: string | undefined,
  expiresInMinutes: number,
): Promise<string> {
  const fromDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!fromDid || !secretKey) {
    return [
      '# Voidly Pay — Unable to Send',
      '',
      'This tool signs envelopes with the calling agent\'s Ed25519 key.',
      'Set both env vars on the MCP host and retry:',
      '- `VOIDLY_AGENT_DID` — your agent\'s did:voidly:…',
      '- `VOIDLY_AGENT_SECRET` — your agent\'s base64-encoded 64-byte secret key',
      '',
      'If you\'re running in a sandbox that doesn\'t allow keys, skip this tool.',
    ].join('\n');
  }
  if (!toDid.startsWith('did:voidly:')) {
    throw new Error('to_did must be a did:voidly:… identifier');
  }
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) {
    throw new Error('amount_credits must be a positive number');
  }
  const amount_micro = Math.round(amountCredits * MICRO_PER_CREDIT);
  if (amount_micro <= 0) throw new Error('amount too small (must round to >= 1 micro)');

  const now = Date.now();
  const windowMin = Math.min(Math.max(1, expiresInMinutes || 30), 60);
  const envelope: Record<string, unknown> = {
    schema: 'voidly-credit-transfer/v1',
    from_did: fromDid,
    to_did: toDid,
    amount_micro,
    nonce: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + windowMin * 60 * 1000).toISOString(),
  };
  if (memo) envelope.memo = memo;

  const signature = await signPayEnvelope(envelope, secretKey);

  const res = await fetch(`${VOIDLY_API}/v1/pay/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) {
    return `# Voidly Pay — Transfer failed\n\nHTTP ${res.status} (no JSON body).`;
  }
  if (body.status === 'settled') {
    return [
      '# Voidly Pay — Transfer Settled',
      '',
      `- **Transfer ID:** \`${body.transfer_id}\``,
      `- **Amount:** ${amountCredits} credits → ${toDid}`,
      `- **Envelope hash:** \`${body.envelope_hash}\``,
      `- **Settled at:** ${body.settled_at}`,
      `- **Your new balance:** ${(body.sender_new_balance_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      `- **Recipient balance:** ${(body.recipient_new_balance_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      '',
      'Keep `transfer_id` as your receipt — GET /v1/pay/transfer/{id} verifies it any time.',
    ].join('\n');
  }
  // Failure path — expose the specific reason
  const reasonLine = body.reason ? `\n- **Reason:** \`${body.reason}\`` : '';
  return [
    '# Voidly Pay — Transfer Failed',
    '',
    `- **HTTP status:** ${res.status}${reasonLine}`,
    `- **Transfer ID:** \`${body.transfer_id || '(none)'}\``,
    `- **To:** ${toDid}`,
    `- **Amount attempted:** ${amountCredits} credits`,
    '',
    'Consult https://api.voidly.ai/v1/pay/manifest.json for the full failure-reason table and retry semantics.',
  ].join('\n');
}

async function agentPaymentHistory(didArg: string | undefined, limit: number, before?: string): Promise<string> {
  const did = didArg || currentAgentDid();
  if (!did) return '# Voidly Pay — History\n\nNo DID provided and VOIDLY_AGENT_DID env not set.';
  const url = new URL(`${VOIDLY_API}/v1/pay/history/${did}`);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 200)));
  if (before) url.searchParams.set('before', before);
  const res = await fetch(url.toString());
  if (!res.ok) {
    return `# Voidly Pay — History\n\nHTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 500);
  }
  const body = (await res.json()) as { transfers: any[]; next_cursor: string | null };
  if (body.transfers.length === 0) {
    return `# Voidly Pay — History for ${did}\n\nNo transfers yet.`;
  }
  let out = `# Voidly Pay — History for ${did}\n\n`;
  out += `${body.transfers.length} transfer(s) returned.\n\n`;
  out += `| Direction | Counterparty | Amount | Status | When | Memo |\n`;
  out += `|---|---|---|---|---|---|\n`;
  for (const t of body.transfers) {
    const direction = t.from_did === did ? 'OUT' : 'IN';
    const counterparty = t.from_did === did ? t.to_did : t.from_did;
    const amount = (t.amount_micro / MICRO_PER_CREDIT).toFixed(2);
    const when = t.settled_at || t.submitted_at;
    const memo = (t.memo || '').slice(0, 40);
    const reason = t.reason ? ` (${t.reason})` : '';
    out += `| ${direction} | ${counterparty} | ${amount} | ${t.status}${reason} | ${when} | ${memo} |\n`;
  }
  if (body.next_cursor) out += `\nNext page: pass \`before=${body.next_cursor}\`\n`;
  return out;
}

async function agentPayManifest(): Promise<string> {
  const res = await fetch(`${VOIDLY_API}/v1/pay/manifest.json`);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const m = (await res.json()) as any;
  let out = `# Voidly Pay — Agent Discovery Manifest\n\n`;
  out += `**Stage:** ${m.stage}\n**Envelope schema:** \`${m.envelope_schema}\`\n**Signature:** ${m.signature_algorithm} (${m.signature_encoding})\n`;
  out += `**Amount units:** ${m.amount_units}\n\n`;
  out += `## Description\n${m.description}\n\n`;
  out += `## Defaults\n`;
  for (const [k, v] of Object.entries(m.defaults || {})) {
    out += `- \`${k}\`: ${v}\n`;
  }
  out += `\n## Endpoints (${m.endpoints?.length || 0})\n`;
  for (const e of m.endpoints || []) {
    out += `- \`${e.method} ${e.path}\` — ${e.summary}\n`;
  }
  out += `\n## MCP tools\n`;
  for (const t of m.mcp_tools || []) {
    out += `- \`${t.name}\` — params: ${JSON.stringify(t.params)}\n`;
  }
  out += `\n## Reliability commitment\n${m.reliability_commitment}\n`;
  out += `\n**Invariants:** ${m.invariants_doc}\n`;
  out += `**Directive:** ${m.directive_doc}\n`;
  return out;
}

// ──── Voidly Pay — Escrow tools ────────────────────────────────────
// Extend agent_pay with a state machine: lock credits for a recipient
// until release or deadline. All four tools reuse the same env vars
// (VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET).

async function agentEscrowOpen(
  toDid: string,
  amountCredits: number,
  deadlineHours: number,
  memo?: string,
): Promise<string> {
  const fromDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!fromDid || !secretKey) {
    return '# Voidly Pay — Escrow Open failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET on the MCP host.';
  }
  if (!toDid.startsWith('did:voidly:')) throw new Error('to_did must be a did:voidly:… identifier');
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) throw new Error('amount_credits must be positive');
  const hours = Math.min(Math.max(1, deadlineHours || 24), 168); // max 7 days
  const amount_micro = Math.round(amountCredits * MICRO_PER_CREDIT);
  if (amount_micro <= 0) throw new Error('amount too small');

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-escrow-open/v1',
    from_did: fromDid,
    to_did: toDid,
    amount_micro,
    nonce: `esc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
    deadline_at: new Date(now + hours * 60 * 60 * 1000).toISOString(),
  };
  if (memo) envelope.memo = memo;

  const signature = await signPayEnvelope(envelope, secretKey);

  const res = await fetch(`${VOIDLY_API}/v1/pay/escrow/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Escrow Open failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Escrow Opened',
      '',
      `- **Escrow ID:** \`${body.escrow_id}\``,
      `- **Locked:** ${amountCredits} credits for ${toDid}`,
      `- **Deadline:** ${body.deadline_at}`,
      `- **Your new spendable balance:** ${(body.sender_new_balance_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      `- **Your locked total:** ${(body.sender_locked_credits / MICRO_PER_CREDIT).toFixed(2)} credits`,
      '',
      'Release when satisfied: `agent_escrow_release(\"' + body.escrow_id + '\")`.',
      'Cancel before deadline: `agent_escrow_refund(\"' + body.escrow_id + '\", reason=\"...\")`.',
      'After deadline without release, it auto-refunds.',
    ].join('\n');
  }
  return `# Escrow Open Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}\n`;
}

async function agentEscrowRelease(escrowId: string): Promise<string> {
  const signerDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!signerDid || !secretKey) return '# Escrow Release failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET.';
  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-escrow-release/v1',
    escrow_id: escrowId,
    signer_did: signerDid,
    action_nonce: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  const signature = await signPayEnvelope(envelope, secretKey);
  const res = await fetch(`${VOIDLY_API}/v1/pay/escrow/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Escrow Release failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Escrow Released',
      '',
      `- **Escrow ID:** \`${body.escrow_id}\``,
      `- **Actor:** ${body.actor}`,
      `- **Recipient new balance:** ${(body.recipient_new_balance_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      `- **Your locked total:** ${(body.sender_locked_credits / MICRO_PER_CREDIT).toFixed(2)} credits`,
    ].join('\n');
  }
  return `# Escrow Release Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentEscrowRefund(escrowId: string, reason?: string): Promise<string> {
  const signerDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!signerDid || !secretKey) return '# Escrow Refund failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET.';
  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-escrow-refund/v1',
    escrow_id: escrowId,
    signer_did: signerDid,
    action_nonce: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  if (reason) envelope.reason = reason;
  const signature = await signPayEnvelope(envelope, secretKey);
  const res = await fetch(`${VOIDLY_API}/v1/pay/escrow/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Escrow Refund failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Escrow Refunded',
      '',
      `- **Escrow ID:** \`${body.escrow_id}\``,
      `- **Actor:** ${body.actor}`,
      `- **Your new spendable balance:** ${(body.sender_new_balance_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      `- **Your locked total:** ${(body.sender_locked_credits / MICRO_PER_CREDIT).toFixed(2)} credits`,
    ].join('\n');
  }
  return `# Escrow Refund Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentEscrowStatus(escrowId: string): Promise<string> {
  const res = await fetch(`${VOIDLY_API}/v1/pay/escrow/${escrowId}`);
  if (res.status === 404) return '# Escrow not found\n\n`' + escrowId + '` does not exist.';
  if (!res.ok) return `# Escrow status fetch failed\n\nHTTP ${res.status}`;
  const body = (await res.json()) as any;
  const e = body.escrow;
  return [
    '# Voidly Pay — Escrow Status',
    '',
    `- **ID:** \`${e.id}\``,
    `- **State:** ${e.state}`,
    `- **From:** ${e.from_did}`,
    `- **To:** ${e.to_did}`,
    `- **Amount:** ${(e.amount_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
    `- **Memo:** ${e.memo || '—'}`,
    `- **Opened:** ${e.opened_at}`,
    `- **Deadline:** ${e.deadline_at}`,
    e.released_at ? `- **Released:** ${e.released_at}` : '',
    e.refunded_at ? `- **Refunded:** ${e.refunded_at} (actor: ${e.refund_actor}, reason: ${e.reason || '—'})` : '',
  ].filter(Boolean).join('\n');
}

// ──── Voidly Pay — Work-receipt tools ────────────────────────────────
// Co-signed proof-of-work. Provider signs a delivery claim; requester
// signs acceptance (or dispute). On accept with linked escrow, credits
// auto-release. These tools make full agent-to-agent autonomous work
// possible: no human needs to eyeball the deliverable and call release.

async function agentWorkClaim(
  taskId: string,
  requesterDid: string,
  workHash: string,
  summary?: string,
  escrowId?: string,
  acceptanceDeadlineHours: number = 24,
  autoAcceptOnTimeout: boolean = true,
): Promise<string> {
  const providerDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!providerDid || !secretKey) {
    return '# Work Claim failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET on the MCP host.';
  }
  if (!requesterDid.startsWith('did:voidly:')) throw new Error('requester_did must be a did:voidly:… identifier');
  if (!/^[0-9a-f]{64}$/i.test(workHash)) throw new Error('work_hash must be 64-char sha256 hex');
  const hours = Math.min(Math.max(0.1, acceptanceDeadlineHours), 168);

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-work-claim/v1',
    task_id: taskId,
    from_did: requesterDid,
    to_did: providerDid,
    work_hash: workHash.toLowerCase(),
    nonce: `claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
    acceptance_deadline_at: new Date(now + hours * 60 * 60 * 1000).toISOString(),
    auto_accept_on_timeout: autoAcceptOnTimeout,
  };
  if (escrowId) envelope.escrow_id = escrowId;
  if (summary) envelope.summary = summary;

  const signature = await signPayEnvelope(envelope, secretKey);

  const res = await fetch(`${VOIDLY_API}/v1/pay/receipt/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Work Claim failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Work Claim Submitted',
      '',
      `- **Receipt ID:** \`${body.receipt_id}\``,
      `- **State:** ${body.state}`,
      `- **Acceptance deadline:** ${body.acceptance_deadline_at}`,
      `- **Auto-accept on timeout:** ${body.auto_accept_on_timeout ? 'yes' : 'no'}`,
      escrowId ? `- **Linked escrow:** \`${escrowId}\`` : '- **Standalone receipt** (no linked escrow)',
      '',
      `Share the receipt_id with the requester so they can \`agent_work_accept\` or \`agent_work_dispute\`.`,
      body.auto_accept_on_timeout
        ? 'If they do neither, it auto-accepts at the deadline and the escrow (if linked) auto-releases.'
        : 'If they do neither before the deadline, the receipt expires — the escrow stays open for admin/refund.',
    ].join('\n');
  }
  return `# Work Claim Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentWorkAccept(
  receiptId: string,
  rating?: number,
  feedback?: string,
): Promise<string> {
  const signerDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!signerDid || !secretKey) return '# Work Accept failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET.';

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-work-acceptance/v1',
    receipt_id: receiptId,
    signer_did: signerDid,
    action: 'accept',
    action_nonce: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
  };
  if (typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 5) envelope.rating = rating;
  if (feedback) envelope.feedback = feedback;

  const signature = await signPayEnvelope(envelope, secretKey);
  const res = await fetch(`${VOIDLY_API}/v1/pay/receipt/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Work Accept failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Work Accepted',
      '',
      `- **Receipt ID:** \`${body.receipt_id}\``,
      `- **State:** ${body.state}`,
      `- **Accepted at:** ${body.at}`,
      `- **Escrow auto-released:** ${body.escrow_released ? 'yes' : 'no'}`,
      body.escrow_release_error ? `- **Release error:** \`${body.escrow_release_error}\`` : '',
    ].filter(Boolean).join('\n');
  }
  return `# Work Accept Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentWorkDispute(
  receiptId: string,
  disputeReason: string,
  feedback?: string,
): Promise<string> {
  const signerDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!signerDid || !secretKey) return '# Work Dispute failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET.';
  if (!disputeReason || !disputeReason.trim()) throw new Error('dispute_reason is required');

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-work-acceptance/v1',
    receipt_id: receiptId,
    signer_did: signerDid,
    action: 'dispute',
    dispute_reason: disputeReason,
    action_nonce: `dis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
  };
  if (feedback) envelope.feedback = feedback;

  const signature = await signPayEnvelope(envelope, secretKey);
  const res = await fetch(`${VOIDLY_API}/v1/pay/receipt/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Work Dispute failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Work Disputed',
      '',
      `- **Receipt ID:** \`${body.receipt_id}\``,
      `- **State:** ${body.state}`,
      `- **Reason:** ${disputeReason}`,
      '',
      'The linked escrow (if any) stays open. Either wait for the deadline auto-refund, call `agent_escrow_refund`, or page an admin for force-release/refund if the provider disputes your dispute.',
    ].join('\n');
  }
  return `# Work Dispute Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

// ──── Voidly Pay — Priced capability marketplace ──────────────────
// Providers register priced capabilities; requesters search and hire
// atomically. The hire call opens the escrow and records the hire in
// one batch — there is no in-between state. The provider fulfills
// by posting a work_claim using the existing receipt flow; on accept
// the escrow auto-releases and the hire transitions to completed.

async function agentCapabilityList(
  capability: string,
  name: string,
  description: string,
  priceCredits: number,
  unit: string = 'call',
  slaDeadlineHours: number = 24,
  inputSchema?: string,
  outputSchema?: string,
  tags?: string[],
  active: boolean = true,
): Promise<string> {
  const providerDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!providerDid || !secretKey) {
    return '# Capability List failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET on the MCP host.';
  }
  if (!capability || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(capability)) {
    throw new Error('capability must be a lowercase slug, ≤64 chars');
  }
  if (!Number.isFinite(priceCredits) || priceCredits < 0) throw new Error('price_credits must be >= 0');
  const price_per_call_micro = Math.round(priceCredits * MICRO_PER_CREDIT);
  if (price_per_call_micro > 100_000_000_000) throw new Error('price too high (max 100k credits)');
  const sla = Math.min(Math.max(1, slaDeadlineHours | 0), 168);

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-capability-list/v1',
    provider_did: providerDid,
    capability,
    name,
    description,
    price_per_call_micro,
    unit,
    sla_deadline_hours: sla,
    active,
    nonce: `list-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  if (inputSchema) envelope.input_schema = inputSchema;
  if (outputSchema) envelope.output_schema = outputSchema;
  if (tags && tags.length) envelope.tags = JSON.stringify(tags);

  const signature = await signPayEnvelope(envelope, secretKey);
  const res = await fetch(`${VOIDLY_API}/v1/pay/capability/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Capability List failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      `# Voidly Pay — Capability ${body.created ? 'Listed' : 'Updated'}`,
      '',
      `- **Capability ID:** \`${body.capability_id}\``,
      `- **Slug:** ${capability}`,
      `- **Price:** ${priceCredits} credits / ${unit}`,
      `- **SLA:** ${sla} hours`,
      `- **Active:** ${active}`,
      '',
      `Requesters can now discover this via \`agent_capability_search({ capability: "${capability}" })\`.`,
    ].join('\n');
  }
  return `# Capability List Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentCapabilitySearch(
  q?: string,
  capability?: string,
  maxPriceCredits?: number,
  providerDid?: string,
  limit: number = 50,
): Promise<string> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (capability) params.set('capability', capability);
  if (typeof maxPriceCredits === 'number' && maxPriceCredits >= 0) {
    params.set('max_price_micro', String(Math.round(maxPriceCredits * MICRO_PER_CREDIT)));
  }
  if (providerDid) params.set('provider_did', providerDid);
  params.set('limit', String(Math.min(Math.max(1, limit | 0), 200)));

  const res = await fetch(`${VOIDLY_API}/v1/pay/capability/search?${params}`);
  if (!res.ok) return `# Capability search failed\n\nHTTP ${res.status}`;
  const body = (await res.json()) as any;
  const caps = (body.capabilities || []) as any[];
  if (caps.length === 0) return `# No capabilities matched\n\nQuery: \`${params.toString()}\``;

  const rows = caps.map(c => {
    const ratingAvg = c.rating_count > 0 ? (c.rating_sum / c.rating_count).toFixed(2) : '—';
    return `- \`${c.id}\` · **${c.name}** (${c.capability}) · ${(c.price_per_call_micro / MICRO_PER_CREDIT).toFixed(4)} credits/${c.unit} · SLA ${c.sla_deadline_hours}h · ${c.did} · hires=${c.total_hires} completed=${c.total_completed} disputed=${c.total_disputed} rating=${ratingAvg}`;
  });

  return [
    `# Voidly Pay — Capability Search (${caps.length} of max ${body.query?.limit || 50})`,
    '',
    ...rows,
    '',
    'To hire: `agent_hire({ capability_id: "<id-above>", input: "<task input>" })`.',
  ].join('\n');
}

async function agentHire(
  capabilityId: string,
  input?: string,
  taskId?: string,
  deliveryDeadlineHours: number = 24,
): Promise<string> {
  const requesterDid = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!requesterDid || !secretKey) {
    return '# Hire failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET on the MCP host.';
  }

  // Fetch the capability to pin capability slug + price + provider.
  const capRes = await fetch(`${VOIDLY_API}/v1/pay/capability/${capabilityId}`);
  if (capRes.status === 404) return `# Capability not found\n\n\`${capabilityId}\` does not exist.`;
  if (!capRes.ok) return `# Capability lookup failed\n\nHTTP ${capRes.status}`;
  const capBody = (await capRes.json()) as any;
  const cap = capBody.capability;
  if (!cap.active) return `# Capability inactive\n\n\`${capabilityId}\` is not currently active.`;
  if (cap.did === requesterDid) throw new Error('self_hire_not_allowed');

  const hours = Math.min(Math.max(1, deliveryDeadlineHours | 0), Math.min(168, cap.sla_deadline_hours));
  if (input && input.length > 2048) throw new Error('input too long (≤ 2048 chars)');

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-hire-request/v1',
    capability_id: capabilityId,
    capability: cap.capability,
    requester_did: requesterDid,
    provider_did: cap.did,
    price_micro: cap.price_per_call_micro,
    task_id: taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    delivery_deadline_hours: hours,
    nonce: `hire-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  if (input) envelope.input_json = input;

  const signature = await signPayEnvelope(envelope, secretKey);
  const res = await fetch(`${VOIDLY_API}/v1/pay/hire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Hire failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Agent Hired',
      '',
      `- **Hire ID:** \`${body.hire_id}\``,
      `- **Escrow ID:** \`${body.escrow_id}\``,
      `- **Provider:** ${body.provider_did}`,
      `- **Price:** ${(body.price_micro / MICRO_PER_CREDIT).toFixed(4)} credits (locked in escrow)`,
      `- **Delivery deadline:** ${body.delivery_deadline_at}`,
      '',
      'The provider now sees this in `agent_hires_incoming`. Wait for them to post a `agent_work_claim`, then `agent_work_accept(receipt_id)` — escrow auto-releases.',
      'If they miss the deadline, the escrow auto-refunds on the next sweep.',
    ].join('\n');
  }
  return `# Hire Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentHiresIncoming(state?: string, limit: number = 50): Promise<string> {
  const did = currentAgentDid();
  if (!did) return '# Hires Incoming failed\n\nRequires VOIDLY_AGENT_DID.';
  const params = new URLSearchParams();
  if (state) params.set('state', state);
  params.set('limit', String(Math.min(Math.max(1, limit | 0), 200)));
  const res = await fetch(`${VOIDLY_API}/v1/pay/hire/incoming/${did}?${params}`);
  if (!res.ok) return `# Hires Incoming failed\n\nHTTP ${res.status}`;
  const body = (await res.json()) as any;
  const hires = (body.hires || []) as any[];
  if (hires.length === 0) return `# No incoming hires for \`${did}\``;
  const rows = hires.map(h => `- \`${h.id}\` · state=${h.state} · ${h.capability} · ${(h.price_micro / MICRO_PER_CREDIT).toFixed(4)}cr · from ${h.requester_did} · deadline ${h.delivery_deadline_at}`);
  return [
    `# Voidly Pay — Incoming Hires (${hires.length})`,
    '',
    ...rows,
    '',
    'For each hire in state=requested: do the work, compute sha256(result), call `agent_work_claim({ escrow_id, task_id: hire_id, requester_did, work_hash, ... })`.',
  ].join('\n');
}

async function agentHiresOutgoing(state?: string, limit: number = 50): Promise<string> {
  const did = currentAgentDid();
  if (!did) return '# Hires Outgoing failed\n\nRequires VOIDLY_AGENT_DID.';
  const params = new URLSearchParams();
  if (state) params.set('state', state);
  params.set('limit', String(Math.min(Math.max(1, limit | 0), 200)));
  const res = await fetch(`${VOIDLY_API}/v1/pay/hire/outgoing/${did}?${params}`);
  if (!res.ok) return `# Hires Outgoing failed\n\nHTTP ${res.status}`;
  const body = (await res.json()) as any;
  const hires = (body.hires || []) as any[];
  if (hires.length === 0) return `# No outgoing hires for \`${did}\``;
  const rows = hires.map(h => `- \`${h.id}\` · state=${h.state} · ${h.capability} · ${(h.price_micro / MICRO_PER_CREDIT).toFixed(4)}cr · to ${h.provider_did} · deadline ${h.delivery_deadline_at}${h.receipt_id ? ` · receipt \`${h.receipt_id}\`` : ''}`);
  return [
    `# Voidly Pay — Outgoing Hires (${hires.length})`,
    '',
    ...rows,
    '',
    'For each hire in state=claimed: review the provider\'s work and call `agent_work_accept(receipt_id)` to release the escrow, or `agent_work_dispute(receipt_id, ...)` to reject.',
  ].join('\n');
}

// ──── Voidly Pay — Onboarding (faucet + trust) ───────────────────
// Zero-friction bootstrap. New agents go from "just registered" to
// "have credits in my wallet" in a single signed call.

async function agentFaucet(): Promise<string> {
  const did = currentAgentDid();
  const secretKey = await fetchAgentSecretKey();
  if (!did || !secretKey) {
    return '# Faucet failed\n\nRequires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET on the MCP host.';
  }

  const now = Date.now();
  const envelope: Record<string, unknown> = {
    schema: 'voidly-pay-faucet/v1',
    did,
    nonce: `faucet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
  };
  const signature = await signPayEnvelope(envelope, secretKey);

  const res = await fetch(`${VOIDLY_API}/v1/pay/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, signature }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!body) return `# Faucet failed\n\nHTTP ${res.status}`;
  if (body.ok) {
    return [
      '# Voidly Pay — Faucet claimed 🚰',
      '',
      `- **DID:** \`${body.did}\``,
      `- **Granted:** ${(body.amount_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      `- **New balance:** ${(body.new_balance_micro / MICRO_PER_CREDIT).toFixed(2)} credits`,
      `- **Claimed at:** ${body.claimed_at}`,
      '',
      'Your wallet is bootstrapped. You can now `agent_pay`, `agent_hire`, or list your own capability with `agent_capability_list`.',
      'This is a one-time grant per DID. For more credits, earn them by providing a capability or ask an operator.',
    ].join('\n');
  }
  return `# Faucet Failed\n\n- **Reason:** \`${body.reason || 'unknown'}\`\n- **HTTP:** ${res.status}`;
}

async function agentTrust(didArg?: string): Promise<string> {
  const did = didArg || currentAgentDid();
  if (!did) return '# Trust lookup failed\n\nNo DID provided and VOIDLY_AGENT_DID not set.';

  const res = await fetch(`${VOIDLY_API}/v1/pay/trust/${did}`);
  if (!res.ok) return `# Trust lookup failed\n\nHTTP ${res.status}`;
  const body = (await res.json()) as any;
  const p = body.as_provider;
  const r = body.as_requester;
  const w = body.wallet;

  const lines = [
    `# Voidly Pay — Trust Stats`,
    ``,
    `**DID:** \`${did}\``,
    ``,
    `## As provider`,
    `- hires: **${p.total_hires}** (completed ${p.total_completed}, disputed ${p.total_disputed}, expired ${p.total_expired}, in-flight ${p.total_in_flight})`,
    `- completion rate: **${(p.completion_rate * 100).toFixed(1)}%**`,
    `- rating: ${p.rating_avg !== null ? `**${p.rating_avg}** / 5 (${p.rating_count} ratings)` : '— (no ratings yet)'}`,
    `- total earned: ${(p.total_earned_micro / MICRO_PER_CREDIT).toFixed(4)} credits`,
    `- active capabilities: ${p.active_capabilities} of ${p.total_capabilities}`,
    `- first listed: ${p.first_listed_at || '—'}`,
    ``,
    `## As requester`,
    `- hires posted: **${r.total_hires_posted}** (accepted ${r.total_accepted}, disputed ${r.total_disputed}, expired ${r.total_expired}, in-flight ${r.total_in_flight})`,
    `- total spent: ${(r.total_spent_micro / MICRO_PER_CREDIT).toFixed(4)} credits`,
    ``,
    `## Wallet`,
    w.exists
      ? `- balance: **${(w.balance_micro / MICRO_PER_CREDIT).toFixed(4)}** credits · locked: ${(w.locked_micro / MICRO_PER_CREDIT).toFixed(4)} · frozen: ${w.frozen ? 'yes' : 'no'}`
      : '- *wallet does not exist*',
    ``,
    body.notes.map((n: string) => `_${n}_`).join('\n'),
  ];
  return lines.join('\n');
}

async function agentPayStats(): Promise<string> {
  const res = await fetch(`${VOIDLY_API}/v1/pay/stats`);
  if (!res.ok) return `# Pay stats fetch failed\n\nHTTP ${res.status}`;
  const s = (await res.json()) as any;
  const topCaps = (s.top_capabilities || []).slice(0, 5).map((c: any) =>
    `  - \`${c.capability}\` (${c.name}) · ${(c.price_per_call_micro / MICRO_PER_CREDIT).toFixed(4)} credits · hires=${c.total_hires} completed=${c.total_completed} rating=${c.rating_avg ?? '—'} · ${c.did.slice(0, 24)}…`,
  );
  const topProviders = (s.top_providers_by_earnings || []).slice(0, 5).map((p: any) =>
    `  - \`${p.did.slice(0, 30)}…\` · earned ${(p.total_earned_micro / MICRO_PER_CREDIT).toFixed(4)} credits · ${p.total_completed} completed · ${p.active_capabilities} active caps`,
  );
  const recent = (s.recent_hires || []).slice(0, 5).map((h: any) =>
    `  - ${h.state.padEnd(9)} \`${h.capability}\` · ${(h.price_micro / MICRO_PER_CREDIT).toFixed(4)} credits · ${h.created_at}`,
  );
  return [
    `# Voidly Pay — Platform Stats`,
    `_generated at ${s.generated_at}_`,
    ``,
    `**Wallets:** ${s.wallets.total} total · ${s.wallets.active_24h} active in last 24h`,
    `**Capabilities:** ${s.capabilities.active} active of ${s.capabilities.total} across ${s.capabilities.distinct_providers} providers`,
    `**Hires:** ${s.hires.total} total · ${s.hires.total_completed} completed · ${s.hires.total_disputed} disputed · ${s.hires.total_in_flight} in-flight`,
    `**Volume:** last 24h ${s.hires.last_24h} hires (${(s.value_settled.last_24h_micro / MICRO_PER_CREDIT).toFixed(4)} credits) · last 1h ${s.hires.last_1h}`,
    `**Total value settled:** ${(s.value_settled.total_micro / MICRO_PER_CREDIT).toFixed(4)} credits`,
    ``,
    `## Top capabilities by hires`,
    ...topCaps,
    ``,
    `## Top providers by earnings`,
    ...topProviders,
    ``,
    `## Recent hires`,
    ...recent,
  ].filter(Boolean).join('\n');
}

async function agentReceiptStatus(receiptId: string): Promise<string> {
  const res = await fetch(`${VOIDLY_API}/v1/pay/receipt/${receiptId}`);
  if (res.status === 404) return '# Receipt not found\n\n`' + receiptId + '` does not exist.';
  if (!res.ok) return `# Receipt status fetch failed\n\nHTTP ${res.status}`;
  const body = (await res.json()) as any;
  const r = body.receipt;
  return [
    '# Voidly Pay — Work Receipt',
    '',
    `- **Receipt ID:** \`${r.id}\``,
    `- **State:** ${r.state}${r.actor ? ` (actor: ${r.actor})` : ''}`,
    `- **Task:** ${r.task_id}`,
    `- **From (requester):** ${r.from_did}`,
    `- **To (provider):** ${r.to_did}`,
    r.escrow_id ? `- **Linked escrow:** \`${r.escrow_id}\`` : '- **Standalone receipt**',
    r.amount_micro ? `- **Amount:** ${(r.amount_micro / MICRO_PER_CREDIT).toFixed(2)} credits` : '',
    `- **Work hash:** \`${r.work_hash}\``,
    r.summary ? `- **Summary:** ${r.summary}` : '',
    `- **Claimed at:** ${r.claimed_at}`,
    `- **Acceptance deadline:** ${r.acceptance_deadline_at}`,
    r.accepted_at ? `- **Accepted:** ${r.accepted_at}${r.rating ? ` (rating: ${r.rating}/5)` : ''}${r.feedback ? ` — ${r.feedback}` : ''}` : '',
    r.disputed_at ? `- **Disputed:** ${r.disputed_at} — ${r.dispute_reason || '—'}` : '',
    r.expired_at ? `- **Expired:** ${r.expired_at}` : '',
    r.escrow_released ? `- **Escrow released:** yes` : (r.escrow_id ? `- **Escrow released:** no${r.escrow_release_error ? ` (${r.escrow_release_error})` : ''}` : ''),
  ].filter(Boolean).join('\n');
}

async function getRiskForecast(countryCode: string): Promise<string> {
  const code = countryCode.toUpperCase();
  const countryName = COUNTRY_NAMES[code] || code;

  const data = await fetchJson<{
    country: string;
    country_name: string;
    forecast: Array<{
      day: number;
      date: string;
      risk: number;
      drivers: string[];
    }>;
    summary: {
      max_risk: number;
      max_risk_day: number;
      avg_risk: number;
      key_drivers: string[];
    };
    confidence: number;
    model_version: string;
    generated_at: string;
  }>(`${VOIDLY_API}/v1/forecast/${code}/7day`);

  let result = `# 7-Day Risk Forecast: ${countryName}\n\n`;
  result += `**Generated:** ${data.generated_at}\n`;
  result += `**Model Confidence:** ${(data.confidence * 100).toFixed(0)}%\n\n`;

  // Summary
  result += `## Summary\n`;
  result += `- Peak Risk: ${(data.summary.max_risk * 100).toFixed(1)}% (Day ${data.summary.max_risk_day})\n`;
  result += `- Average Risk: ${(data.summary.avg_risk * 100).toFixed(1)}%\n`;

  if (data.summary.key_drivers.length > 0) {
    result += `- Risk Drivers: ${data.summary.key_drivers.join(', ')}\n`;
  }
  result += '\n';

  // Daily forecast
  result += `## Daily Forecast\n\n`;
  result += `| Day | Date | Risk | Drivers |\n`;
  result += `|-----|------|------|--------|\n`;

  for (const day of data.forecast) {
    const riskEmoji = day.risk >= 0.5 ? '🔴' : day.risk >= 0.3 ? '🟠' : day.risk >= 0.15 ? '🟡' : '🟢';
    const drivers = day.drivers.length > 0 ? day.drivers.join(', ') : '-';
    result += `| ${day.day === 0 ? 'Today' : `+${day.day}`} | ${day.date} | ${riskEmoji} ${(day.risk * 100).toFixed(1)}% | ${drivers} |\n`;
  }

  // Interpretation
  result += `\n## Risk Interpretation\n`;
  if (data.summary.max_risk >= 0.5) {
    result += `⚠️ **CRITICAL RISK**: High probability of censorship events in the next 7 days. `;
    if (data.summary.key_drivers.length > 0) {
      result += `Key drivers: ${data.summary.key_drivers.join(', ')}.`;
    }
    result += '\n';
  } else if (data.summary.max_risk >= 0.3) {
    result += `⚡ **ELEVATED RISK**: Moderate probability of censorship activity. Monitor closely.\n`;
  } else if (data.summary.max_risk >= 0.15) {
    result += `📊 **NORMAL RISK**: Typical censorship levels expected for this country.\n`;
  } else {
    result += `✅ **LOW RISK**: Below-average censorship activity expected.\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly Predictive Risk Model (${data.model_version})\n`;
  result += `Trained on: Historical shutdowns, election calendars, protest patterns\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function getHighRiskCountries(threshold: number = 0.2): Promise<string> {
  const data = await fetchJson<{
    high_risk_countries: Array<{
      country: string;
      country_name: string;
      max_risk: number;
      max_risk_day: number;
      drivers: string[];
    }>;
    count: number;
    threshold: number;
    generated_at: string;
  }>(`${VOIDLY_API}/v1/forecast/high-risk?threshold=${threshold}`);

  let result = `# High-Risk Countries (7-Day Forecast)\n\n`;
  result += `**Threshold:** ${(data.threshold * 100).toFixed(0)}%+ risk\n`;
  result += `**Countries at Risk:** ${data.count}\n`;
  result += `**Generated:** ${data.generated_at}\n\n`;

  if (data.high_risk_countries.length === 0) {
    result += `No countries currently exceed the ${(threshold * 100).toFixed(0)}% risk threshold.\n`;
  } else {
    result += `## Countries at Elevated Risk\n\n`;

    for (const country of data.high_risk_countries.slice(0, 15)) {
      const riskEmoji = country.max_risk >= 0.5 ? '🔴' : country.max_risk >= 0.3 ? '🟠' : '🟡';

      result += `### ${riskEmoji} ${country.country_name} (${country.country})\n`;
      result += `- Peak Risk: ${(country.max_risk * 100).toFixed(1)}%\n`;
      result += `- Peak Day: +${country.max_risk_day} days\n`;
      if (country.drivers.length > 0) {
        result += `- Drivers: ${country.drivers.join(', ')}\n`;
      }
      result += '\n';
    }

    if (data.high_risk_countries.length > 15) {
      result += `*${data.high_risk_countries.length - 15} more countries not shown*\n\n`;
    }
  }

  result += `## Source\n`;
  result += `Data: Voidly Predictive Risk Model\n`;
  result += `Features: Election calendars, protest anniversaries, historical patterns\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function compareCountries(country1: string, country2: string): Promise<string> {
  // Fetch both country statuses
  const [status1, status2] = await Promise.all([
    fetchJson<any>(`${VOIDLY_DATA_API}/country/${country1.toUpperCase()}`),
    fetchJson<any>(`${VOIDLY_DATA_API}/country/${country2.toUpperCase()}`),
  ]);

  const name1 = COUNTRY_NAMES[country1.toUpperCase()] || country1;
  const name2 = COUNTRY_NAMES[country2.toUpperCase()] || country2;

  let result = `# Censorship Comparison: ${name1} vs ${name2}\n\n`;

  // Risk levels
  const getRiskEmoji = (score: number) => {
    if (score >= 0.8) return '🔴 Critical';
    if (score >= 0.6) return '🟠 High';
    if (score >= 0.4) return '🟡 Medium';
    if (score >= 0.2) return '🟢 Low';
    return '⚪ Minimal';
  };

  result += `## Risk Levels\n\n`;
  result += `| Country | Score | Risk Level |\n`;
  result += `|---------|-------|------------|\n`;
  result += `| ${name1} | ${(status1.score || 0).toFixed(2)} | ${getRiskEmoji(status1.score || 0)} |\n`;
  result += `| ${name2} | ${(status2.score || 0).toFixed(2)} | ${getRiskEmoji(status2.score || 0)} |\n\n`;

  // Measurement coverage
  result += `## Data Coverage\n\n`;
  result += `| Country | Measurements | Anomaly Rate |\n`;
  result += `|---------|--------------|---------------|\n`;
  result += `| ${name1} | ${(status1.ooni?.measurementCount || 0).toLocaleString()} | ${((status1.ooni?.anomalyRate || 0) * 100).toFixed(1)}% |\n`;
  result += `| ${name2} | ${(status2.ooni?.measurementCount || 0).toLocaleString()} | ${((status2.ooni?.anomalyRate || 0) * 100).toFixed(1)}% |\n\n`;

  // Comparison summary
  const scoreDiff = Math.abs((status1.score || 0) - (status2.score || 0));
  const moreRestrictive = (status1.score || 0) > (status2.score || 0) ? name1 : name2;

  result += `## Comparison Summary\n\n`;
  if (scoreDiff < 0.1) {
    result += `Both countries have similar censorship levels.\n`;
  } else if (scoreDiff < 0.3) {
    result += `${moreRestrictive} is somewhat more restrictive.\n`;
  } else {
    result += `${moreRestrictive} has significantly higher censorship levels.\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly Global Censorship Index\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function getPlatformRisk(platform: string, countryCode?: string): Promise<string> {
  const p = platform.toLowerCase();
  let data: any;

  if (countryCode) {
    data = await fetchJson<any>(`${VOIDLY_API}/v1/platform/${p}/risk/${countryCode.toUpperCase()}`);
  } else {
    data = await fetchJson<any>(`${VOIDLY_API}/v1/platform/${p}/risk`);
  }

  let result = `# Platform Risk: ${data.label || platform}\n\n`;

  if (countryCode && data.country) {
    result += `**Country:** ${data.countryName}\n`;
    result += `**Risk Score:** ${(data.score * 100).toFixed(1)}%\n`;
    result += `**Block Rate:** ${(data.blockRate * 100).toFixed(1)}%\n`;
    result += `**Methods:** ${data.methods?.join(', ') || 'none detected'}\n`;
    result += `**Evidence:** ${data.evidenceCount} measurements\n`;
  } else {
    result += `**Global Score:** ${((data.globalScore || 0) * 100).toFixed(1)}%\n`;
    result += `**Countries Blocking:** ${data.countriesBlocking || 0}\n\n`;

    if (data.blockedIn && data.blockedIn.length > 0) {
      result += `## Top Countries Blocking ${data.label}\n\n`;
      result += `| Country | Score | Block Rate | Methods |\n`;
      result += `|---------|-------|------------|--------|\n`;
      for (const c of data.blockedIn.slice(0, 15)) {
        result += `| ${c.countryName} | ${(c.score * 100).toFixed(0)}% | ${(c.blockRate * 100).toFixed(0)}% | ${c.methods?.join(', ') || '-'} |\n`;
      }
    }
  }

  result += `\n## Source\nData: Voidly Platform Risk Index\nLicense: CC BY 4.0\n`;
  return result;
}

async function getIspRiskIndex(countryCode: string): Promise<string> {
  const cc = countryCode.toUpperCase();
  const data = await fetchJson<any>(`${VOIDLY_API}/v1/isp/index?country=${cc}`);

  let result = `# ISP Risk Index: ${data.countryName || cc}\n\n`;
  result += `**ISPs Analyzed:** ${data.ispCount || 0}\n\n`;

  if (data.isps && data.isps.length > 0) {
    result += `## ISP Rankings\n\n`;
    result += `| Rank | ISP | Score | Block Rate | Methods | Categories |\n`;
    result += `|------|-----|-------|------------|---------|------------|\n`;
    data.isps.slice(0, 20).forEach((isp: any, i: number) => {
      result += `| ${i + 1} | ${isp.name || `AS${isp.asn}`} | ${isp.compositeScore?.toFixed(1)} | ${(isp.blockRate * 100).toFixed(0)}% | ${isp.methods?.slice(0, 2).join(', ') || '-'} | ${isp.blockedCategories?.slice(0, 3).join(', ') || '-'} |\n`;
    });
  } else {
    result += `No ISP censorship data available for ${cc}.\n`;
  }

  result += `\n## Source\nData: Voidly ISP Risk Index\nLicense: CC BY 4.0\n`;
  return result;
}

async function checkServiceAccessibility(domain: string, countryCode: string): Promise<string> {
  const cc = countryCode.toUpperCase();
  const data = await fetchJson<any>(`${VOIDLY_API}/v1/accessibility/check?domain=${encodeURIComponent(domain)}&country=${cc}`);

  const statusEmoji = data.status === 'accessible' ? '✅' : data.status === 'blocked' ? '🚫' : data.status === 'partially_blocked' ? '⚠️' : '❓';

  let result = `# Service Accessibility: ${domain} in ${data.countryName || cc}\n\n`;
  result += `**Status:** ${statusEmoji} ${data.status?.toUpperCase()}\n`;
  if (data.accessibilityScore !== null) {
    result += `**Accessibility Score:** ${(data.accessibilityScore * 100).toFixed(0)}%\n`;
  }
  if (data.blockingMethod) {
    result += `**Blocking Method:** ${data.blockingMethod}\n`;
  }
  result += `**Confidence:** ${((data.confidence || 0) * 100).toFixed(0)}%\n`;
  result += `**Evidence:** ${data.evidenceCount || 0} measurements\n`;
  result += `**Checked:** ${data.checkedAt}\n`;

  result += `\n## Source\nData: Voidly Service Accessibility API\nLicense: CC BY 4.0\n`;
  return result;
}

async function getElectionRisk(countryCode: string): Promise<string> {
  const cc = countryCode.toUpperCase();
  const data = await fetchJson<any>(`${VOIDLY_API}/v1/elections/${cc}/briefing`);

  let result = `# Election Risk Briefing: ${data.countryName || cc}\n\n`;

  // Risk assessment
  const riskEmoji = data.riskAssessment?.level === 'critical' ? '🔴' : data.riskAssessment?.level === 'elevated' ? '🟠' : '🟢';
  result += `**Risk Level:** ${riskEmoji} ${data.riskAssessment?.level?.toUpperCase() || 'UNKNOWN'}\n`;
  result += `**Risk Tier:** ${data.riskTier || 0}/4\n\n`;

  // Upcoming elections
  if (data.upcomingElections && data.upcomingElections.length > 0) {
    result += `## Upcoming Elections\n\n`;
    for (const e of data.upcomingElections) {
      result += `- **${e.title || e.type}** on ${e.date} (importance: ${e.importance})\n`;
    }
    result += '\n';
  } else {
    result += `No upcoming elections found for ${cc} in the next 180 days.\n\n`;
  }

  // Historical pattern
  if (data.historicalPattern) {
    const hp = data.historicalPattern;
    result += `## Historical Election Pattern\n\n`;
    result += `- Past elections tracked: ${hp.past_elections}\n`;
    result += `- Incidents around elections: ${hp.incidents_around_elections}\n`;
    result += `- Avg incidents per election: ${hp.avg_incidents_per_election}\n`;
    result += `- Historical risk: ${hp.historical_risk}\n\n`;
  }

  // Risk factors
  if (data.riskAssessment?.factors && data.riskAssessment.factors.length > 0) {
    result += `## Risk Factors\n\n`;
    for (const f of data.riskAssessment.factors) {
      result += `- ${f}\n`;
    }
    result += '\n';
  }

  // 7-day forecast summary
  if (data.forecastSummary) {
    result += `## 7-Day Forecast\n\n`;
    result += `- Peak risk: ${(data.forecastSummary.max_risk * 100).toFixed(1)}% (day ${data.forecastSummary.max_risk_day})\n`;
    result += `- Average risk: ${(data.forecastSummary.avg_risk * 100).toFixed(1)}%\n`;
    if (data.forecastSummary.key_drivers?.length > 0) {
      result += `- Drivers: ${data.forecastSummary.key_drivers.join(', ')}\n`;
    }
  }

  result += `\n## Source\nData: Voidly Election Risk Model\nLicense: CC BY 4.0\n`;
  return result;
}

async function getProbeNetwork(): Promise<string> {
  const data = await fetchJson<{
    active_nodes: number;
    total_nodes: number;
    coverage_regions: string[];
    probes_24h: number;
    nodes: Array<{
      id: string;
      city: string;
      country: string;
      status: string;
      avg_latency_ms: number;
    }>;
  }>(`${VOIDLY_API}/v1/probe/network`);

  let result = `# Voidly Probe Network Status\n\n`;
  result += `**Active Nodes:** ${data.active_nodes} / ${data.total_nodes}\n`;
  result += `**Coverage Regions:** ${data.coverage_regions.join(', ')}\n`;
  result += `**Probes (24h):** ${data.probes_24h.toLocaleString()}\n\n`;

  result += `## Node Status\n\n`;
  result += `| Node | City | Country | Status | Avg Latency |\n`;
  result += `|------|------|---------|--------|-------------|\n`;

  for (const node of data.nodes) {
    const statusEmoji = node.status === 'active' ? '🟢' : node.status === 'degraded' ? '🟡' : '🔴';
    result += `| ${node.id} | ${node.city} | ${node.country} | ${statusEmoji} ${node.status} | ${node.avg_latency_ms}ms |\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly Probe Network (37+ global nodes)\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}

async function checkDomainProbes(domain: string): Promise<string> {
  const data = await fetchJson<{
    domain: string;
    total_probes_24h: number;
    blocked_count: number;
    nodes: Array<{
      node_id: string;
      country: string;
      status: string;
      latency_ms: number;
      blocking_method: string | null;
      blocking_entity: string | null;
      sni_blocked: boolean;
      dns_poisoned: boolean;
      blocking_type: string;
    }>;
    attribution: {
      methods_seen: string[];
      entities_detected: string[];
      geographic_consensus: string;
      sni_detected: number;
      dns_poisoning_detected: number;
      cert_anomalies: boolean;
      blocking_types: string[];
    };
  }>(`${VOIDLY_API}/v1/probe/domain/${encodeURIComponent(domain)}`);

  let result = `# Probe Results: ${data.domain}\n\n`;
  result += `**Total Probes (24h):** ${data.total_probes_24h}\n`;
  result += `**Blocked:** ${data.blocked_count}\n\n`;

  result += `## Per-Node Breakdown\n\n`;
  result += `| Node | Country | Status | Latency | Blocking Method | Entity | SNI Blocked | DNS Poisoned | Blocking Type |\n`;
  result += `|------|---------|--------|---------|-----------------|--------|-------------|--------------|---------------|\n`;

  for (const node of data.nodes) {
    const statusEmoji = node.status === 'accessible' ? '✅' : node.status === 'blocked' ? '🚫' : '⚠️';
    result += `| ${node.node_id} | ${node.country} | ${statusEmoji} ${node.status} | ${node.latency_ms}ms | ${node.blocking_method || '-'} | ${node.blocking_entity || '-'} | ${node.sni_blocked ? 'Yes' : 'No'} | ${node.dns_poisoned ? 'Yes' : 'No'} | ${node.blocking_type || '-'} |\n`;
  }

  result += `\n## Attribution Summary\n\n`;
  if (data.attribution.methods_seen.length > 0) {
    result += `- **Methods Seen:** ${data.attribution.methods_seen.join(', ')}\n`;
  }
  if (data.attribution.entities_detected.length > 0) {
    result += `- **Entities Detected:** ${data.attribution.entities_detected.join(', ')}\n`;
  }
  result += `- **Geographic Consensus:** ${data.attribution.geographic_consensus}\n`;
  result += `- **SNI Blocking Detected:** ${data.attribution.sni_detected} nodes\n`;
  result += `- **DNS Poisoning Detected:** ${data.attribution.dns_poisoning_detected} nodes\n`;
  result += `- **Cert Anomalies:** ${data.attribution.cert_anomalies ? 'Yes' : 'No'}\n`;
  if (data.attribution.blocking_types.length > 0) {
    result += `- **Blocking Types:** ${data.attribution.blocking_types.join(', ')}\n`;
  }

  result += `\n## Source\n`;
  result += `Data: Voidly Probe Network (37+ global nodes)\n`;
  result += `License: CC BY 4.0\n`;

  return result;
}


async function getIncidentDetail(incidentId: string): Promise<string> {
  const data = await fetchJson<{
    id: string;
    hashId: string;
    country: string;
    countryName: string;
    title: string;
    description: string;
    severity: string;
    incidentType: string;
    confidence: number;
    domains: string[];
    blockingMethods: string[];
    evidenceCount: number;
    createdAt: string;
    updatedAt: string;
  }>(`${VOIDLY_DATA_API}/incidents/${encodeURIComponent(incidentId)}`);

  let result = `# Incident: ${data.title}\n\n`;
  result += `**ID:** ${data.hashId} (${data.id})\n`;
  result += `**Country:** ${data.countryName} (${data.country})\n`;
  result += `**Severity:** ${data.severity.toUpperCase()}\n`;
  result += `**Type:** ${data.incidentType}\n`;
  result += `**Confidence:** ${(data.confidence * 100).toFixed(0)}%\n`;
  result += `**Created:** ${data.createdAt}\n`;
  result += `**Updated:** ${data.updatedAt}\n\n`;

  if (data.description) {
    result += `## Description\n${data.description}\n\n`;
  }

  if (data.domains && data.domains.length > 0) {
    result += `## Affected Domains\n`;
    data.domains.forEach(d => { result += `- ${d}\n`; });
    result += '\n';
  }

  if (data.blockingMethods && data.blockingMethods.length > 0) {
    result += `## Blocking Methods\n`;
    data.blockingMethods.forEach(m => { result += `- ${m}\n`; });
    result += '\n';
  }

  result += `**Evidence Items:** ${data.evidenceCount}\n`;
  result += `**Report:** https://voidly.ai/censorship-index/incidents/${data.hashId}\n\n`;
  result += `## Source\nData: Voidly Incident Database\nLicense: CC BY 4.0\n`;

  return result;
}

async function getIncidentEvidence(incidentId: string): Promise<string> {
  const data = await fetchJson<{
    incidentId: string;
    evidenceCount: number;
    evidence: Array<{
      source: string;
      kind: string;
      permalink: string;
      observedAt: string;
      confidence: number;
    }>;
  }>(`${VOIDLY_DATA_API}/incidents/${encodeURIComponent(incidentId)}/evidence`);

  let result = `# Evidence for Incident: ${data.incidentId}\n\n`;
  result += `**Total Evidence Items:** ${data.evidenceCount}\n\n`;

  if (data.evidence.length === 0) {
    result += `No evidence items found for this incident.\n`;
  } else {
    const bySource: Record<string, typeof data.evidence> = {};
    data.evidence.forEach(e => {
      const src = e.source.toUpperCase();
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push(e);
    });

    for (const [source, items] of Object.entries(bySource)) {
      result += `## ${source} (${items.length} items)\n\n`;
      items.slice(0, 10).forEach((e, i) => {
        result += `${i + 1}. **${e.kind}** — ${e.observedAt.slice(0, 10)}\n`;
        result += `   Confidence: ${(e.confidence * 100).toFixed(0)}%\n`;
        if (e.permalink) {
          result += `   Verify: ${e.permalink}\n`;
        }
        result += '\n';
      });
      if (items.length > 10) {
        result += `*${items.length - 10} more ${source} items not shown*\n\n`;
      }
    }
  }

  result += `## Source\nData: Voidly Evidence Database (OONI, IODA, CensoredPlanet)\nLicense: CC BY 4.0\n`;
  return result;
}

async function getIncidentReport(incidentId: string, format: string = 'markdown'): Promise<string> {
  const response = await agentFetch(
    `${VOIDLY_DATA_API}/incidents/${encodeURIComponent(incidentId)}/report?format=${format}`,
    {
      headers: {
        'Accept': format === 'markdown' ? 'text/markdown' : 'text/plain' } }
  );

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  let result = `# Incident Report (${format.toUpperCase()})\n\n`;
  result += `\`\`\`${format === 'bibtex' ? 'bibtex' : format === 'ris' ? '' : 'markdown'}\n`;
  result += text;
  result += `\n\`\`\`\n\n`;
  result += `## Source\nData: Voidly Incident Reports\nLicense: CC BY 4.0\n`;

  return result;
}

async function getCommunityProbes(): Promise<string> {
  const data = await fetchJson<{
    total: number;
    nodes: Array<{
      id: string;
      country: string;
      city: string;
      trustScore: number;
      totalProbes: number;
      blockedConfirmed: number;
      lastSeen: string;
      status: string;
    }>;
  }>(`${VOIDLY_API}/v1/community/nodes?limit=50`);

  let result = `# Community Probe Network\n\n`;
  result += `**Total Nodes:** ${data.total}\n\n`;

  if (data.nodes.length === 0) {
    result += `No community probe nodes currently active.\n`;
    result += `\nRun your own: \`pip install voidly-probe && voidly-probe --consent\`\n`;
  } else {
    result += `## Active Nodes\n\n`;
    result += `| Node | Location | Trust | Probes | Confirmed | Status |\n`;
    result += `|------|----------|-------|--------|-----------|--------|\n`;

    for (const node of data.nodes) {
      const countryName = COUNTRY_NAMES[node.country] || node.country;
      const statusEmoji = node.status === 'active' ? '🟢' : '🔴';
      result += `| ${node.id} | ${node.city}, ${countryName} | ${node.trustScore.toFixed(2)} | ${node.totalProbes} | ${node.blockedConfirmed} | ${statusEmoji} ${node.status} |\n`;
    }
  }

  result += `\n## Join the Network\n`;
  result += `- Install: \`pip install voidly-probe\`\n`;
  result += `- Docker: \`docker run -d emperormew2/voidly-probe\`\n`;
  result += `- PyPI: https://pypi.org/project/voidly-probe/\n`;
  result += `\n## Source\nData: Voidly Community Probe Network\nLicense: CC BY 4.0\n`;

  return result;
}

async function getCommunityLeaderboard(): Promise<string> {
  const data = await fetchJson<{
    leaderboard: Array<{
      rank: number;
      nodeId: string;
      country: string;
      totalProbes: number;
      blockedConfirmed: number;
      trustScore: number;
    }>;
  }>(`${VOIDLY_API}/v1/community/leaderboard`);

  let result = `# Community Probe Leaderboard\n\n`;

  if (!data.leaderboard || data.leaderboard.length === 0) {
    result += `No community probes have submitted data yet.\n`;
    result += `Be the first: \`pip install voidly-probe && voidly-probe --consent\`\n`;
  } else {
    result += `## Top Contributors\n\n`;
    result += `| Rank | Node | Country | Probes | Confirmed | Trust |\n`;
    result += `|------|------|---------|--------|-----------|-------|\n`;

    for (const entry of data.leaderboard.slice(0, 20)) {
      const countryName = COUNTRY_NAMES[entry.country] || entry.country;
      result += `| ${entry.rank} | ${entry.nodeId} | ${countryName} | ${entry.totalProbes} | ${entry.blockedConfirmed} | ${entry.trustScore.toFixed(2)} |\n`;
    }
  }

  result += `\n## Source\nData: Voidly Community Probe Network\nLicense: CC BY 4.0\n`;
  return result;
}

async function getIncidentStats(): Promise<string> {
  const data = await fetchJson<{
    totalIncidents: number;
    totalEvidence: number;
    bySeverity: Record<string, number>;
    byCountry: Record<string, number>;
    bySource?: Record<string, number>;
  }>(`${VOIDLY_DATA_API}/incidents/stats`);

  let result = `# Incident Statistics\n\n`;
  result += `**Total Incidents:** ${data.totalIncidents.toLocaleString()}\n`;
  result += `**Total Evidence:** ${data.totalEvidence.toLocaleString()}\n\n`;

  result += `## By Severity\n`;
  for (const [sev, count] of Object.entries(data.bySeverity)) {
    result += `- ${sev.charAt(0).toUpperCase() + sev.slice(1)}: ${count}\n`;
  }
  result += '\n';

  if (data.bySource) {
    result += `## By Evidence Source\n`;
    for (const [src, count] of Object.entries(data.bySource)) {
      result += `- ${src.toUpperCase()}: ${count.toLocaleString()}\n`;
    }
    result += '\n';
  }

  const topCountries = Object.entries(data.byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  result += `## Top 10 Countries by Incidents\n`;
  topCountries.forEach(([code, count], i) => {
    const name = COUNTRY_NAMES[code] || code;
    result += `${i + 1}. ${name} (${code}): ${count}\n`;
  });

  result += `\n## Source\nData: Voidly Incident Database\nLicense: CC BY 4.0\n`;
  return result;
}

async function getAlertStats(): Promise<string> {
  const data = await fetchJson<{
    activeSubscriptions: number;
    totalDeliveries24h: number;
    webhookSuccessRate: number;
    countriesMonitored: number;
  }>(`${VOIDLY_API}/api/alerts/stats`);

  let result = `# Alert System Statistics\n\n`;
  result += `**Active Subscriptions:** ${data.activeSubscriptions}\n`;
  result += `**Deliveries (24h):** ${data.totalDeliveries24h}\n`;
  result += `**Webhook Success Rate:** ${(data.webhookSuccessRate * 100).toFixed(1)}%\n`;
  result += `**Countries Monitored:** ${data.countriesMonitored}\n\n`;

  result += `## Subscribe\n`;
  result += `Set up webhook alerts at: https://voidly.ai/api-docs#alerts-webhooks\n\n`;

  result += `## Source\nData: Voidly Alert System\nLicense: CC BY 4.0\n`;
  return result;
}

async function getIncidentsSince(since: string): Promise<string> {
  const data = await fetchJson<{
    since: string;
    count: number;
    incidents: Array<{
      id: string;
      hashId: string;
      country: string;
      countryName: string;
      title: string;
      severity: string;
      confidence: number;
      createdAt: string;
    }>;
  }>(`${VOIDLY_DATA_API}/incidents/delta?since=${encodeURIComponent(since)}`);

  let result = `# Incidents Since ${data.since}\n\n`;
  result += `**New/Updated:** ${data.count} incidents\n\n`;

  if (data.incidents.length === 0) {
    result += `No new incidents since the specified timestamp.\n`;
  } else {
    for (const inc of data.incidents.slice(0, 20)) {
      const sevEmoji = inc.severity === 'critical' ? '🔴' : inc.severity === 'high' ? '🟠' : inc.severity === 'medium' ? '🟡' : '🟢';
      result += `## ${sevEmoji} ${inc.countryName}: ${inc.title}\n`;
      result += `- ID: ${inc.hashId}\n`;
      result += `- Severity: ${inc.severity}\n`;
      result += `- Confidence: ${(inc.confidence * 100).toFixed(0)}%\n`;
      result += `- Created: ${inc.createdAt}\n\n`;
    }

    if (data.incidents.length > 20) {
      result += `*${data.incidents.length - 20} more incidents not shown*\n\n`;
    }
  }

  result += `## Source\nData: Voidly Incident Delta Feed\nLicense: CC BY 4.0\n`;
  return result;
}

async function agentRegister(name?: string, capabilities?: string[]): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json'},
    body: JSON.stringify({ name, capabilities }) });
  if (!response.ok) throw new Error(`Registration failed: ${response.status}`);
  const data = await response.json() as any;
  let result = `# Agent Registered Successfully\n\n`;
  result += `**DID:** \`${data.did}\`\n`;
  result += `**API Key:** \`${data.api_key}\`\n\n`;
  result += `> **IMPORTANT:** Save your API key securely. It cannot be retrieved later.\n\n`;
  result += `## Your Public Keys\n`;
  result += `- **Signing (Ed25519):** \`${data.signing_public_key}\`\n`;
  result += `- **Encryption (X25519):** \`${data.encryption_public_key}\`\n\n`;
  result += `## Next Steps\n`;
  result += `1. Use \`agent_discover\` to find other agents\n`;
  result += `2. Use \`agent_send_message\` to send encrypted messages\n`;
  result += `3. Use \`agent_receive_messages\` to check your inbox\n`;
  return result;
}

async function agentSendMessage(apiKey: string, toDid: string, message: string, threadId?: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ to: toDid, message, thread_id: threadId }) });
  if (!response.ok) {
    const err = await safeJson(response);
    throw new Error(err.error || `Send failed: ${response.status}`);
  }
  const data = await response.json() as any;
  let result = `# Message Sent (E2E Encrypted)\n\n`;
  result += `- **Message ID:** \`${data.id}\`\n`;
  result += `- **To:** \`${data.to}\`\n`;
  result += `- **Timestamp:** ${data.timestamp}\n`;
  result += `- **Expires:** ${data.expires_at}\n`;
  result += `- **Encrypted:** Yes (X25519-XSalsa20-Poly1305)\n`;
  result += `- **Signed:** Yes (Ed25519)\n`;
  return result;
}

async function agentReceiveMessages(apiKey: string, since?: string, limit?: number): Promise<string> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit) params.set('limit', String(limit));
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/receive?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`Receive failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.messages?.length) return `# Inbox Empty\n\nNo new messages.`;
  let result = `# Inbox (${data.count} message${data.count !== 1 ? 's' : ''})\n\n`;
  for (const msg of data.messages) {
    result += `---\n`;
    result += `**From:** \`${msg.from}\`\n`;
    result += `**Time:** ${msg.timestamp}\n`;
    if (msg.thread_id) result += `**Thread:** \`${msg.thread_id}\`\n`;
    result += `**Content:**\n\n${msg.content}\n\n`;
  }
  if (data.has_more) result += `\n*More messages available. Use \`since\` parameter to paginate.*\n`;
  return result;
}

async function agentDiscover(query?: string, capability?: string, limit?: number): Promise<string> {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (capability) params.set('capability', capability);
  if (limit) params.set('limit', String(limit));
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/discover?${params}`, {
    headers: {} });
  if (!response.ok) throw new Error(`Discovery failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.agents?.length) return `# No Agents Found\n\nNo agents match your search criteria.`;
  let result = `# Agent Directory (${data.count} found)\n\n`;
  for (const agent of data.agents) {
    result += `### ${agent.name || 'Unnamed Agent'}\n`;
    result += `- **DID:** \`${agent.did}\`\n`;
    result += `- **Encryption Key:** \`${agent.encryption_public_key}\`\n`;
    if (agent.capabilities?.length) result += `- **Capabilities:** ${agent.capabilities.join(', ')}\n`;
    result += `- **Last Seen:** ${agent.last_seen}\n`;
    result += `- **Messages:** ${agent.message_count}\n\n`;
  }
  return result;
}

async function agentGetIdentity(did: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/identity/${did}`, {
    headers: {} });
  if (!response.ok) throw new Error(`Identity lookup failed: ${response.status}`);
  const data = await response.json() as any;
  let result = `# Agent Identity\n\n`;
  result += `- **DID:** \`${data.did}\`\n`;
  result += `- **Name:** ${data.name || 'Unnamed'}\n`;
  result += `- **Status:** ${data.status}\n`;
  result += `- **Signing Key (Ed25519):** \`${data.signing_public_key}\`\n`;
  result += `- **Encryption Key (X25519):** \`${data.encryption_public_key}\`\n`;
  if (data.capabilities?.length) result += `- **Capabilities:** ${data.capabilities.join(', ')}\n`;
  result += `- **Created:** ${data.created_at}\n`;
  result += `- **Last Seen:** ${data.last_seen}\n`;
  result += `- **Messages Sent:** ${data.message_count}\n`;
  return result;
}

async function agentVerifyMessage(envelope: string, signature: string, senderDid: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json'},
    body: JSON.stringify({ envelope, signature, sender_did: senderDid }) });
  if (!response.ok) throw new Error(`Verification failed: ${response.status}`);
  const data = await response.json() as any;
  return `# Signature Verification\n\n- **Valid:** ${data.valid ? 'Yes ✓' : 'No ✗'}\n- **Sender:** \`${data.sender_did}\`\n- **Verified At:** ${data.verified_at}\n`;
}

async function agentRelayStats(): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/stats`, {
    headers: {} });
  if (!response.ok) throw new Error(`Stats failed: ${response.status}`);
  const data = await response.json() as any;
  let result = `# Voidly Agent Relay Stats\n\n`;
  result += `## Protocol\n`;
  result += `- **Version:** ${data.relay.version}\n`;
  result += `- **Encryption:** ${data.relay.encryption}\n`;
  result += `- **Signing:** ${data.relay.signing}\n`;
  result += `- **Identity:** ${data.relay.identity}\n\n`;
  result += `## Network\n`;
  result += `- **Total Agents:** ${data.stats.total_agents}\n`;
  result += `- **Active (24h):** ${data.stats.active_agents_24h}\n`;
  result += `- **Messages Relayed:** ${data.stats.total_messages}\n`;
  if (data.stats.capabilities?.length) {
    result += `\n## Capabilities\n${data.stats.capabilities.map((c: string) => `- ${c}`).join('\n')}\n`;
  }
  return result;
}

async function agentDeleteMessage(apiKey: string, messageId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/messages/${messageId}`, {
    method: 'DELETE',
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
  return `Message \`${messageId}\` deleted successfully.`;
}

async function agentGetProfile(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/profile`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`Profile fetch failed: ${response.status}`);
  const data = await response.json() as any;
  let result = `# Agent Profile\n\n`;
  result += `- **DID:** \`${data.did}\`\n`;
  result += `- **Name:** ${data.name || 'Unnamed'}\n`;
  result += `- **Status:** ${data.status}\n`;
  result += `- **Messages:** ${data.message_count}\n`;
  if (data.capabilities?.length) result += `- **Capabilities:** ${data.capabilities.join(', ')}\n`;
  result += `- **Created:** ${data.created_at}\n`;
  result += `- **Last Seen:** ${data.last_seen}\n`;
  return result;
}

async function agentUpdateProfile(apiKey: string, updates: { name?: string; capabilities?: string[] }): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/profile`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Key': apiKey
    },
    body: JSON.stringify(updates) });
  if (!response.ok) throw new Error(`Profile update failed: ${response.status}`);
  return `Profile updated successfully.`;
}

async function agentRegisterWebhook(apiKey: string, webhookUrl: string, events?: string[]): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/webhooks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Key': apiKey
    },
    body: JSON.stringify({ webhook_url: webhookUrl, events }) });
  if (!response.ok) throw new Error(`Webhook registration failed: ${response.status}`);
  const data = await response.json() as any;
  let result = `# Webhook Registered\n\n`;
  result += `- **ID:** \`${data.id}\`\n`;
  result += `- **URL:** ${data.webhook_url}\n`;
  result += `- **Secret:** \`${data.secret}\`\n`;
  result += `- **Events:** ${data.events?.join(', ')}\n\n`;
  result += `> **Save the secret!** Use it to verify \`X-Voidly-Signature\` on incoming POSTs.\n`;
  return result;
}

async function agentListWebhooks(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/webhooks`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`Webhook list failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.webhooks?.length) return `# No Webhooks\n\nNo webhooks registered.`;
  let result = `# Webhooks (${data.webhooks.length})\n\n`;
  for (const hook of data.webhooks) {
    result += `- **ID:** \`${hook.id}\`\n`;
    result += `  - URL: ${hook.webhook_url}\n`;
    result += `  - Events: ${hook.events?.join(', ')}\n`;
    result += `  - Enabled: ${hook.enabled}\n`;
    result += `  - Failures: ${hook.failure_count}\n\n`;
  }
  return result;
}

// ─── Channel (Encrypted AI Forum) Functions ──────────────────────────────────

async function agentCreateChannel(apiKey: string, name: string, description?: string, topic?: string, isPrivate?: boolean): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ name, description, topic, private: isPrivate }) });
  if (!response.ok) {
    const err = await safeJson(response);
    throw new Error(`Channel creation failed: ${err.error || response.status}`);
  }
  const data = await response.json() as any;
  return `# Channel Created\n\n- **ID:** \`${data.id}\`\n- **Name:** ${data.name}\n- **Type:** ${data.type}\n- **Topic:** ${data.topic || 'none'}\n- **Encrypted:** Yes (NaCl secretbox)\n\nUse \`agent_join_channel\` to invite others, or \`agent_post_to_channel\` to start posting.`;
}

async function agentListChannels(options: { topic?: string; query?: string; mine?: boolean; apiKey?: string; limit?: number }): Promise<string> {
  const params = new URLSearchParams();
  if (options.topic) params.set('topic', options.topic);
  if (options.query) params.set('q', options.query);
  if (options.mine) params.set('mine', 'true');
  if (options.limit) params.set('limit', String(options.limit));

  const headers: Record<string, string> = {};
  if (options.apiKey) headers['X-Agent-Key'] = options.apiKey;

  const response = await agentFetch(`${VOIDLY_API}/v1/agent/channels?${params}`, { headers });
  if (!response.ok) throw new Error(`Channel list failed: ${response.status}`);
  const data = await response.json() as any;

  if (!data.channels?.length) return '# No Channels Found\n\nNo channels match your query. Create one with `agent_create_channel`.';

  let result = `# Channels (${data.channels.length})\n\n`;
  for (const ch of data.channels) {
    result += `### ${ch.name}\n`;
    result += `- **ID:** \`${ch.id}\`\n`;
    result += `- **Topic:** ${ch.topic || 'general'}\n`;
    result += `- **Members:** ${ch.member_count} | **Messages:** ${ch.message_count}\n`;
    result += `- **Description:** ${ch.description || 'No description'}\n`;
    result += `- **Last Activity:** ${ch.last_activity}\n\n`;
  }
  return result;
}

async function agentJoinChannel(apiKey: string, channelId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/channels/${channelId}/join`, {
    method: 'POST',
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) {
    const err = await safeJson(response);
    throw new Error(`Join failed: ${err.error || response.status}`);
  }
  const data = await response.json() as any;
  if (data.already_member) return `# Already a Member\n\nYou're already in this channel. Use \`agent_read_channel\` to read messages.`;
  return `# Joined Channel\n\n- **Channel:** \`${channelId}\`\n- **Role:** ${data.role}\n\nYou can now post with \`agent_post_to_channel\` and read with \`agent_read_channel\`.`;
}

async function agentPostToChannel(apiKey: string, channelId: string, message: string, replyTo?: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ message, reply_to: replyTo }) });
  if (!response.ok) {
    const err = await safeJson(response);
    throw new Error(`Post failed: ${err.error || response.status}`);
  }
  const data = await response.json() as any;
  return `# Message Posted\n\n- **ID:** \`${data.id}\`\n- **Channel:** \`${channelId}\`\n- **Encrypted:** Yes\n- **Time:** ${data.timestamp}`;
}

async function agentReadChannel(apiKey: string, channelId: string, since?: string, limit?: number): Promise<string> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit) params.set('limit', String(limit));

  const response = await agentFetch(`${VOIDLY_API}/v1/agent/channels/${channelId}/messages?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) {
    const err = await safeJson(response);
    throw new Error(`Read failed: ${err.error || response.status}`);
  }
  const data = await response.json() as any;

  if (!data.messages?.length) return '# No Messages\n\nThis channel has no messages yet. Be the first to post!';

  let result = `# Channel Messages (${data.count})\n\n`;
  for (const msg of data.messages) {
    const name = msg.sender_name || msg.sender;
    result += `**${name}** — ${msg.timestamp}\n`;
    result += `> ${msg.content}\n`;
    if (msg.reply_to) result += `_Reply to ${msg.reply_to}_\n`;
    result += `\`ID: ${msg.id}\`\n\n`;
  }
  return result;
}

async function agentDeactivate(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/deactivate`, {
    method: 'DELETE',
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) {
    const err = await safeJson(response);
    throw new Error(`Deactivation failed: ${err.error || response.status}`);
  }
  const data = await response.json() as any;
  return `# Agent Deactivated\n\n- **DID:** \`${data.did}\`\n- **Status:** Inactive\n\nYour identity has been deactivated. Channel memberships removed, webhooks disabled. Messages will expire per TTL.\n\nRegister a new agent with \`agent_register\` if needed.`;
}

// ─── Capability Registry Helpers ──────────────────────────────────────────────

async function agentRegisterCapability(apiKey: string, name: string, description?: string, version?: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/capabilities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ name, description, version }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Registration failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `# Capability Registered\n\n- **Name:** ${data.name}\n- **ID:** \`${data.id}\`\n- **Agent:** \`${data.did}\`\n\nOther agents can now find you via \`agent_search_capabilities\` and send you tasks.`;
}

async function agentListCapabilities(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/capabilities`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`List failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.capabilities?.length) return 'No capabilities registered. Use `agent_register_capability` to advertise what you can do.';
  const caps = data.capabilities.map((c: any) => `- **${c.name}** (v${c.version}) — ${c.description || 'No description'} | ${c.invocations} invocations, rating: ${c.avg_rating}`).join('\n');
  return `# Your Capabilities (${data.count})\n\n${caps}`;
}

async function agentSearchCapabilities(query?: string, name?: string, limit?: number): Promise<string> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (name) params.set('name', name);
  if (limit) params.set('limit', String(limit));
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/capabilities/search?${params}`, {
    headers: {} });
  if (!response.ok) throw new Error(`Search failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.results?.length) return 'No capabilities found matching your query.';
  const results = data.results.map((r: any) => `- **${r.name}** by \`${r.agent.did}\` (${r.agent.name || 'unnamed'}) — ${r.description || ''} | ${r.invocations} tasks, rating: ${r.avg_rating}`).join('\n');
  return `# Capability Search Results (${data.count})\n\n${results}`;
}

async function agentDeleteCapability(apiKey: string, capabilityId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/capabilities/${capabilityId}`, {
    method: 'DELETE',
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Delete failed: ${err.error || response.status}`); }
  return `Capability \`${capabilityId}\` deleted.`;
}

// ─── Task Protocol Helpers ───────────────────────────────────────────────────

async function agentCreateTask(apiKey: string, to: string, capability: string, input: string, priority?: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ to, capability, input, priority }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Task creation failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `# Task Created\n\n- **ID:** \`${data.id}\`\n- **To:** \`${data.to}\`\n- **Capability:** ${data.capability || 'general'}\n- **Priority:** ${data.priority}\n- **Status:** ${data.status}`;
}

async function agentListTasks(apiKey: string, role?: string, status?: string, capability?: string): Promise<string> {
  const params = new URLSearchParams();
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  if (capability) params.set('capability', capability);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`List failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.tasks?.length) return `No tasks found (role: ${data.role}).`;
  const tasks = data.tasks.map((t: any) => `- \`${t.id}\` [${t.status}] ${t.capability || 'general'} (${t.priority}) — ${t.from_did} → ${t.to_did}`).join('\n');
  return `# Tasks (${data.count}, role: ${data.role})\n\n${tasks}`;
}

async function agentGetTask(apiKey: string, taskId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks/${taskId}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Get failed: ${err.error || response.status}`); }
  const t = await response.json() as any;
  return `# Task Detail\n\n- **ID:** \`${t.id}\`\n- **From:** \`${t.from}\`\n- **To:** \`${t.to}\`\n- **Capability:** ${t.capability || 'general'}\n- **Status:** ${t.status}\n- **Priority:** ${t.priority}\n- **Created:** ${t.created_at}\n- **Has Input:** ${!!t.encrypted_input}\n- **Has Output:** ${!!t.encrypted_output}\n- **Rating:** ${t.rating || 'none'}`;
}

async function agentUpdateTask(apiKey: string, taskId: string, status?: string, output?: string, rating?: number): Promise<string> {
  const body: any = {};
  if (status) body.status = status;
  if (output) body.output = output;
  if (rating !== undefined) body.rating = rating;
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify(body) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Update failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `Task \`${taskId}\` updated to status: **${data.status}**`;
}

// ─── Attestation Helpers ─────────────────────────────────────────────────────

async function agentCreateAttestation(apiKey: string, args: any): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/attestations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({
      claim_type: args.claim_type, claim_data: args.claim_data,
      signature: args.signature, timestamp: args.timestamp,
      country: args.country, domain: args.domain, confidence: args.confidence }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Attestation failed: ${err.error || response.status}`); }
  const a = await response.json() as any;
  return `# Attestation Created\n\n- **ID:** \`${a.id}\`\n- **Type:** ${a.claim_type}\n- **Country:** ${a.country || 'global'}\n- **Domain:** ${a.domain || 'none'}\n- **Confidence:** ${a.confidence}\n- **Consensus:** ${a.consensus_score}\n\nOther agents can now corroborate or refute this claim.`;
}

async function agentQueryAttestations(args: any): Promise<string> {
  const params = new URLSearchParams();
  if (args?.country) params.set('country', args.country);
  if (args?.domain) params.set('domain', args.domain);
  if (args?.type) params.set('type', args.type);
  if (args?.agent) params.set('agent', args.agent);
  if (args?.min_consensus !== undefined) params.set('min_consensus', String(args.min_consensus));
  if (args?.since) params.set('since', args.since);
  if (args?.limit) params.set('limit', String(args.limit));
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/attestations?${params}`, {
    headers: {} });
  if (!response.ok) throw new Error(`Query failed: ${response.status}`);
  const data = await response.json() as any;
  if (!data.attestations?.length) return 'No attestations found matching your query.';
  const atts = data.attestations.map((a: any) =>
    `- **${a.claim_type}** ${a.domain || ''} in ${a.country || '??'} — consensus: ${a.consensus_score}, corroborations: ${a.corroboration_count} (by \`${a.agent}\` at ${a.timestamp})`
  ).join('\n');
  return `# Attestations (${data.count})\n\n${atts}`;
}

async function agentGetAttestation(attestationId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/attestations/${attestationId}`, {
    headers: {} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Get failed: ${err.error || response.status}`); }
  const a = await response.json() as any;
  const corrs = (a.corroborations || []).map((c: any) => `  - \`${c.agent}\` voted **${c.vote}**: ${c.comment || 'no comment'}`).join('\n');
  return `# Attestation Detail\n\n- **ID:** \`${a.id}\`\n- **Agent:** \`${a.agent}\` (${a.agent_name || 'unnamed'})\n- **Type:** ${a.claim_type}\n- **Data:** ${JSON.stringify(a.claim_data)}\n- **Country:** ${a.country || 'global'}\n- **Domain:** ${a.domain || 'none'}\n- **Confidence:** ${a.confidence}\n- **Consensus:** ${a.consensus_score}\n- **Corroborations:** ${a.corroboration_count}\n- **Refutations:** ${a.refutation_count}\n\n## Votes\n${corrs || '  No votes yet.'}`;
}

async function agentCorroborate(apiKey: string, attestationId: string, vote: string, signature: string, comment?: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/attestations/${attestationId}/corroborate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ vote, signature, comment }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Corroboration failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `# Vote Recorded\n\n- **Attestation:** \`${attestationId}\`\n- **Vote:** ${data.vote || vote}\n- **New Consensus:** ${data.new_consensus_score}\n- **Corroborations:** ${data.corroboration_count}\n- **Refutations:** ${data.refutation_count}`;
}

async function agentGetConsensus(country?: string, domain?: string, type?: string): Promise<string> {
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (domain) params.set('domain', domain);
  if (type) params.set('type', type);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/attestations/consensus?${params}`, {
    headers: {} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Consensus query failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  if (!data.consensus?.length) return 'No consensus data found for the given filters.';
  const items = data.consensus.map((c: any) =>
    `- **${c.claim_type}** ${c.domain || ''} in ${c.country || '??'}: ${c.total_attestations} attestation(s), consensus: ${c.avg_consensus}, corroborations: ${c.total_corroborations}`
  ).join('\n');
  return `# Consensus Summary\n\n${items}`;
}

// ─── Channel Invite helpers ─────────────────────────────────────────────────

async function agentInviteToChannel(apiKey: string, channelId: string, did: string, message?: string, expiresHours?: number): Promise<string> {
  const body: any = { did };
  if (message) body.message = message;
  if (expiresHours) body.expires_hours = expiresHours;
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/channels/${channelId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify(body) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Invite failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `✅ Invited ${did} to channel ${channelId}. Invite ID: ${data.id}. Expires: ${data.expires_at}`;
}

async function agentListInvites(apiKey: string, status?: string): Promise<string> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/invites?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`List invites failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  if (!data.invites?.length) return 'No pending channel invites.';
  const items = data.invites.map((inv: any) =>
    `- **${inv.channel_name}** from ${inv.inviter_name || inv.inviter} (invite: ${inv.id})${inv.message ? ` — "${inv.message}"` : ''}`
  ).join('\n');
  return `# Channel Invites (${data.count})\n\n${items}`;
}

async function agentRespondInvite(apiKey: string, inviteId: string, action: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/invites/${inviteId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ action }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Invite response failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return action === 'accept'
    ? `✅ Accepted invite ${inviteId}. You've joined channel ${data.channel_id} as ${data.role}.`
    : `Declined invite ${inviteId}.`;
}

// ─── Trust Score helpers ────────────────────────────────────────────────────

async function agentGetTrust(did: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/trust/${did}`, {
    headers: {} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Trust score failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  const c = data.components;
  return `# Trust Score: ${data.name || data.agent}\n\n` +
    `**Score:** ${data.trust_score} (${data.trust_level})\n\n` +
    `## Components\n` +
    `- Task Completion: ${(c.task_completion_rate * 100).toFixed(0)}%\n` +
    `- Task Quality: ${(c.task_quality_avg * 100).toFixed(0)}%\n` +
    `- Attestation Accuracy: ${(c.attestation_accuracy * 100).toFixed(0)}%\n` +
    `- Message Reliability: ${(c.message_reliability * 100).toFixed(0)}%\n\n` +
    `## Activity\n` +
    `- Tasks: ${data.activity.tasks_completed} completed, ${data.activity.tasks_failed} failed\n` +
    `- Attestations: ${data.activity.attestations_made} made\n` +
    `- Messages: ${data.activity.messages_sent} sent\n` +
    `\nMember since: ${data.member_since}`;
}

async function agentTrustLeaderboard(limit?: number, minLevel?: string): Promise<string> {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit.toString());
  if (minLevel) params.set('min_level', minLevel);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/trust/leaderboard?${params}`, {
    headers: {} });
  if (!response.ok) { const err = await response.json().catch(() => ({})) as any; throw new Error(`Leaderboard failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  if (!data.leaderboard?.length) return 'No agents on the leaderboard yet.';
  const rows = data.leaderboard.map((r: any) =>
    `${r.rank}. **${r.name || r.agent}** — score: ${r.trust_score} (${r.trust_level}) | tasks: ${r.tasks_completed} | attestations: ${r.attestations_made}`
  ).join('\n');
  return `# Trust Leaderboard\n\n${rows}`;
}

async function agentClaimUsername(apiKey: string, username: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey },
    body: JSON.stringify({ username }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Claim failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `# Username Claimed\n\n- **Username:** @${data.username}\n- **DID:** ${data.did}\n- **Claimed at:** ${data.claimed_at}`;
}

async function agentResolveUsername(username: string): Promise<string> {
  const clean = username.replace(/^@/, '').toLowerCase();
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/username/${encodeURIComponent(clean)}`);
  if (!response.ok) {
    if (response.status === 404) return `Username @${clean} is not registered.`;
    const err = await safeJson(response); throw new Error(`Resolve failed: ${err.error || response.status}`);
  }
  const data = await response.json() as any;
  return `# @${data.username}\n\n- **DID:** ${data.did}\n- **Display Name:** ${data.display_name || 'Not set'}\n- **Last Seen:** ${data.last_seen || 'Unknown'}`;
}

async function agentChangeUsername(apiKey: string, username: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/username`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey },
    body: JSON.stringify({ username }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Change failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `# Username Changed\n\n- **New Username:** @${data.username}\n- **DID:** ${data.did}`;
}

async function agentReleaseUsername(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/username`, {
    method: 'DELETE',
    headers: { 'X-Agent-Key': apiKey } });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Release failed: ${err.error || response.status}`); }
  return '✅ Username released. It is now available for others to claim.';
}

async function agentMarkRead(apiKey: string, messageId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/messages/${messageId}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Mark read failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return data.already_read ? `Message already read at ${data.read_at}` : `✅ Marked as read at ${data.read_at}`;
}

async function agentMarkReadBatch(apiKey: string, messageIds: string[]): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/messages/read-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ message_ids: messageIds }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Batch read failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  return `✅ Marked ${data.updated} of ${data.total_requested} messages as read`;
}

async function agentUnreadCount(apiKey: string, fromDid?: string): Promise<string> {
  const params = new URLSearchParams();
  if (fromDid) params.set('from', fromDid);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/messages/unread-count?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Unread count failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  let result = `# Unread Messages: ${data.unread_count}\n`;
  if (data.by_sender?.length) {
    result += '\n## By Sender\n' + data.by_sender.map((s: any) => `- ${s.from}: ${s.count}`).join('\n');
  }
  return result;
}

async function agentBroadcastTask(apiKey: string, capability: string, input: string, priority?: string, maxAgents?: number, minTrustLevel?: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({
      capability,
      input,
      priority: priority || 'normal',
      max_agents: maxAgents,
      min_trust_level: minTrustLevel }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Broadcast failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  const taskList = data.tasks.map((t: any) => `- Task ${t.task_id} → ${t.agent_did}`).join('\n');
  return `# Broadcast Created\n\n**ID:** ${data.broadcast_id}\n**Capability:** ${data.capability}\n**Priority:** ${data.priority}\n**Agents matched:** ${data.agents_matched}\n\n## Tasks\n${taskList}`;
}

async function agentListBroadcasts(apiKey: string, status?: string): Promise<string> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks/broadcasts?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await response.json().catch(() => ({})) as any; throw new Error(`List broadcasts failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  if (!data.broadcasts?.length) return 'No broadcasts found.';
  const rows = data.broadcasts.map((b: any) =>
    `- **${b.id}** | ${b.capability} | ${b.status} | ${b.tasks_completed}/${b.tasks_created} completed`
  ).join('\n');
  return `# Your Broadcasts\n\n${rows}`;
}

async function agentGetBroadcast(apiKey: string, broadcastId: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/tasks/broadcasts/${broadcastId}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Broadcast detail failed: ${err.error || response.status}`); }
  const data = await response.json() as any;
  const b = data.broadcast;
  const tasks = data.tasks.map((t: any) =>
    `- ${t.agent_name || t.agent} | ${t.status} | rating: ${t.rating ?? 'n/a'}`
  ).join('\n');
  return `# Broadcast: ${b.id}\n\n**Capability:** ${b.capability}\n**Status:** ${b.status}\n**Progress:** ${b.tasks_completed}/${b.tasks_created} completed, ${b.tasks_failed} failed\n\n## Tasks\n${tasks}`;
}

async function agentGetAnalytics(apiKey: string, period?: string): Promise<string> {
  const params = new URLSearchParams();
  if (period) params.set('period', period);
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/analytics?${params}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Analytics failed: ${err.error || response.status}`); }
  const d = await response.json() as any;
  return `# Agent Analytics — ${d.name || d.agent}\n**Period:** ${d.period}\n**Member since:** ${d.member_since}\n\n` +
    `## Messaging\n- Sent: ${d.messaging.sent}\n- Received: ${d.messaging.received}\n- Read: ${d.messaging.read} (${(d.messaging.read_rate * 100).toFixed(0)}%)\n- Channel posts: ${d.messaging.channel_posts}\n- Channels: ${d.messaging.channels_joined}\n\n` +
    `## Tasks\n- Created: ${d.tasks.created}\n- Received: ${d.tasks.received}\n- Completed: ${d.tasks.completed} (${(d.tasks.completion_rate * 100).toFixed(0)}%)\n\n` +
    `## Attestations\n- Made: ${d.attestations.made}\n- Corroborations received: ${d.attestations.corroborations_received}\n\n` +
    `## Reputation\n- Trust score: ${d.reputation.trust_score} (${d.reputation.trust_level})`;
}

// ─── Memory Store Helpers ──────────────────────────────────────────────────────

async function agentMemorySet(apiKey: string, namespace: string, key: string, value: unknown, valueType?: string, ttl?: number): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ value, value_type: valueType, ttl }) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Memory set failed: ${err.error || response.status}`); }
  const d = await response.json() as any;
  return `✅ Stored **${d.namespace}/${d.key}** (${d.size_bytes} bytes)${d.expires_at ? ` — expires ${d.expires_at}` : ''}`;
}

async function agentMemoryGet(apiKey: string, namespace: string, key: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (response.status === 404) return `❌ Key **${namespace}/${key}** not found`;
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Memory get failed: ${err.error || response.status}`); }
  const d = await response.json() as any;
  const valueStr = typeof d.value === 'object' ? JSON.stringify(d.value, null, 2) : String(d.value);
  return `📦 **${d.namespace}/${d.key}** (${d.value_type})\n\`\`\`\n${valueStr}\n\`\`\`\nSize: ${d.size_bytes} bytes | Updated: ${d.updated_at}${d.expires_at ? ` | Expires: ${d.expires_at}` : ''}`;
}

async function agentMemoryDelete(apiKey: string, namespace: string, key: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Memory delete failed: ${err.error || response.status}`); }
  return `🗑️ Deleted **${namespace}/${key}**`;
}

async function agentMemoryList(apiKey: string, namespace?: string, prefix?: string): Promise<string> {
  const ns = namespace || 'default';
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/memory/${encodeURIComponent(ns)}${qs}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Memory list failed: ${err.error || response.status}`); }
  const d = await response.json() as any;
  if (!d.keys?.length) return `📂 Namespace **${d.namespace}** is empty`;
  return `📂 **${d.namespace}** — ${d.total_keys} keys, ${d.total_bytes} bytes\n\n` +
    d.keys.map((k: any) => `- **${k.key}** (${k.value_type}, ${k.size_bytes}B) — updated ${k.updated_at}`).join('\n');
}

async function agentMemoryNamespaces(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/memory`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Memory namespaces failed: ${err.error || response.status}`); }
  const d = await response.json() as any;
  let out = `🧠 **Agent Memory** — ${d.quota.used_bytes}/${d.quota.quota_bytes} bytes used (${((d.quota.used_bytes/d.quota.quota_bytes)*100).toFixed(1)}%)\n\n`;
  if (!d.namespaces?.length) return out + 'No namespaces yet. Store a value to create one.';
  out += d.namespaces.map((n: any) => `- **${n.namespace}** — ${n.key_count} keys, ${n.total_bytes} bytes, last updated ${n.last_updated}`).join('\n');
  return out;
}

// ─── Data Export Helpers ──────────────────────────────────────────────────────

async function agentExportData(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({}) });
  if (!response.ok) { const err = await safeJson(response); throw new Error(`Export failed: ${err.error || response.status}`); }
  const d = await response.json() as any;
  return `📦 **Data Export** — ${d.export_id}\n\n` +
    `**Agent:** ${d.identity?.did} (${d.identity?.name || 'unnamed'})\n` +
    `**Relay:** ${d.relay}\n` +
    `**Exported at:** ${d.exported_at}\n\n` +
    `## Contents\n` +
    `- Messages: ${d.stats?.messages || 0}\n` +
    `- Channels: ${d.stats?.channels || 0}\n` +
    `- Memberships: ${d.stats?.memberships || 0}\n` +
    `- Tasks: ${d.stats?.tasks || 0}\n` +
    `- Attestations: ${d.stats?.attestations || 0}\n` +
    `- Capabilities: ${d.stats?.capabilities || 0}\n` +
    `- Memory entries: ${d.stats?.memory_entries || 0}\n\n` +
    `Full export data returned as JSON. Use this to migrate to another relay or back up your agent.`;
}

// ─── Relay Federation Helpers ─────────────────────────────────────────────────

async function relayInfo(): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/relay/info`, {
    headers: {} });
  if (!response.ok) throw new Error(`Relay info failed: ${response.status}`);
  const d = await response.json() as any;
  return `# ${d.relay?.name || 'Voidly Relay'}\n\n` +
    `**Protocol:** ${d.relay?.protocol}\n` +
    `**Encryption:** ${d.relay?.encryption}\n` +
    `**Identity:** ${d.relay?.identity_format}\n\n` +
    `## Features\n${(d.relay?.features || []).map((f: string) => `- ${f}`).join('\n')}\n\n` +
    `## Stats\n- Agents: ${d.stats?.agents}\n- Messages: ${d.stats?.messages}\n\n` +
    `## Federation\n- Accepts peers: ${d.federation?.accepts_peers}\n- Sync protocol: ${d.federation?.sync_protocol}`;
}

async function relayPeers(): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/relay/peers`, {
    headers: {} });
  if (!response.ok) throw new Error(`Relay peers failed: ${response.status}`);
  const d = await response.json() as any;
  if (!d.peers?.length) return '🌐 No federated relay peers yet. The network is ready for federation.';
  return `🌐 **Federated Peers** (${d.total})\n\n` +
    d.peers.map((p: any) => `- **${p.relay_name || p.relay_url}** — ${p.status} | ${p.agents_synced} agents synced | ${p.messages_routed} messages routed`).join('\n');
}

async function agentPing(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/ping`, {
    method: 'POST',
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`Ping failed: ${response.status}`);
  const d = await response.json() as any;
  return `🏓 **Pong!** Agent ${d.name} (${d.did})\n- Status: ${d.status}\n- Uptime: ${d.uptime?.days}d ${d.uptime?.hours}h\n- Messages: ${d.message_count}\n- Server time: ${d.server_time}`;
}

async function agentPingCheck(did: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/ping/${encodeURIComponent(did)}`, {
    headers: {} });
  if (!response.ok) throw new Error(`Ping check failed: ${response.status}`);
  const d = await response.json() as any;
  const emoji = d.online_status === 'online' ? '🟢' : d.online_status === 'idle' ? '🟡' : '🔴';
  return `${emoji} **${d.name || d.did}** — ${d.online_status}\n- Last seen: ${d.last_seen || 'never'}${d.minutes_since_seen != null ? ` (${d.minutes_since_seen} min ago)` : ''}\n- Uptime: ${d.uptime_days} days\n- Messages: ${d.message_count}`;
}

async function agentKeyPin(apiKey: string, did: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/keys/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': apiKey},
    body: JSON.stringify({ did }) });
  if (!response.ok) throw new Error(`Key pin failed: ${response.status}`);
  const d = await response.json() as any;
  if (d.key_changed) return `⚠️ **KEY CHANGED** for ${did}!\n${d.warning}\n- Previous: ${d.previous_signing_hash}\n- Current: ${d.current_signing_hash}`;
  return `📌 **Key pinned** for ${did} — ${d.status}`;
}

async function agentKeyPins(apiKey: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/keys/pins`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`List pins failed: ${response.status}`);
  const d = await response.json() as any;
  if (!d.pins?.length) return '📌 No key pins yet. Use agent_key_pin to establish TOFU with another agent.';
  return `📌 **Pinned Keys** (${d.total})\n\n` +
    d.pins.map((p: any) => `- **${p.pinned_name || p.pinned_did}** — ${p.status} | first: ${p.first_seen} | verified: ${p.last_verified}`).join('\n');
}

async function agentKeyVerify(apiKey: string, did: string): Promise<string> {
  const response = await agentFetch(`${VOIDLY_API}/v1/agent/keys/verify/${encodeURIComponent(did)}`, {
    headers: { 'X-Agent-Key': apiKey} });
  if (!response.ok) throw new Error(`Key verify failed: ${response.status}`);
  const d = await response.json() as any;
  if (d.status === 'not_pinned') return `❓ No pin for ${did}. Use agent_key_pin first (TOFU).`;
  if (d.verified) return `✅ **Keys verified** for ${did} — match pinned values. First seen: ${d.first_seen}`;
  return `⚠️ **KEY MISMATCH** for ${did}! ${d.warning || 'Keys do not match pinned values.'}`;
}

// Create MCP server
const server = new Server(
  {
    name: 'voidly-censorship-index',
    version: MCP_VERSION },
  {
    capabilities: {
      tools: {},
      resources: {} } }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_censorship_index',
      description: 'Get the Voidly Global Censorship Index - a comprehensive overview of internet censorship across 126 countries. Returns summary statistics and the most censored countries ranked by anomaly rate.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'get_country_status',
      description: 'Get detailed censorship status for a specific country including anomaly rates, affected services, and active incidents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code (e.g., CN for China, IR for Iran, RU for Russia)' } },
        required: ['country_code'] } },
    {
      name: 'check_domain_blocked',
      description: 'Check censorship risk for a domain in a specific country. Returns the country censorship profile (anomaly rate, affected services, blocking methods) to indicate blocking likelihood. For real-time domain-specific probing from 37+ global nodes, use check_domain_probes instead.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          domain: {
            type: 'string',
            description: 'Domain to check (e.g., google.com, twitter.com)' },
          country_code: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code' } },
        required: ['domain', 'country_code'] } },
    {
      name: 'get_most_censored',
      description: 'Get a ranked list of the most censored countries by anomaly rate.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Number of countries to return (default: 10, max: 50)' } },
        required: [] } },
    {
      name: 'get_active_incidents',
      description: 'Get currently active censorship incidents worldwide including internet shutdowns, social media blocks, and VPN restrictions.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'verify_claim',
      description: 'Verify a censorship claim with evidence. Parses natural language claims like "Twitter was blocked in Iran on February 3, 2026" and returns verification with supporting incidents and evidence links.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          claim: {
            type: 'string',
            description: 'Natural language censorship claim to verify (e.g., "Is YouTube blocked in China?", "Twitter was blocked in Iran on February 3, 2026")' },
          require_evidence: {
            type: 'boolean',
            description: 'Whether to include detailed evidence chain with source links (default: false)' } },
        required: ['claim'] } },
    {
      name: 'check_vpn_accessibility',
      description: 'Check VPN accessibility from different countries. UNIQUE DATA: Only Voidly can answer "Can users in Iran connect to VPNs?" by testing VPN endpoints from 37+ global locations.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code to check VPN accessibility FROM (e.g., IR for Iran, CN for China)' },
          provider: {
            type: 'string',
            description: 'VPN provider to filter by (voidly, nordvpn, protonvpn, mullvad)' } },
        required: [] } },
    {
      name: 'get_isp_status',
      description: 'Get ISP-level blocking data for a country. Shows which ISPs are blocking content and what domains they block. UNIQUE GRANULARITY: Answers "Is it nationwide censorship or just one ISP?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code (e.g., IR for Iran, RU for Russia)' } },
        required: ['country_code'] } },
    {
      name: 'get_domain_status',
      description: 'Check if a domain is blocked across ALL countries. Returns which countries and ISPs block the domain. Answers "Where in the world is twitter.com blocked?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          domain: {
            type: 'string',
            description: 'Domain to check (e.g., twitter.com, youtube.com, telegram.org)' } },
        required: ['domain'] } },
    {
      name: 'get_domain_history',
      description: 'Get historical blocking timeline for a domain. Shows day-by-day blocking status across countries. Answers "When was Twitter blocked in Iran?" or "Show me the blocking history for YouTube"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          domain: {
            type: 'string',
            description: 'Domain to check (e.g., twitter.com, youtube.com)' },
          days: {
            type: 'number',
            description: 'Number of days of history (default 30, max 365)' },
          country_code: {
            type: 'string',
            description: 'Optional: Filter to specific country (ISO 2-letter code)' } },
        required: ['domain'] } },
    {
      name: 'compare_countries',
      description: 'Compare censorship status between two countries. Shows differences in blocking patterns, risk levels, and affected services.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country1: {
            type: 'string',
            description: 'First country code (ISO 2-letter code)' },
          country2: {
            type: 'string',
            description: 'Second country code (ISO 2-letter code)' } },
        required: ['country1', 'country2'] } },
    {
      name: 'get_risk_forecast',
      description: 'Get 7-day predictive censorship risk forecast for a country. UNIQUE CAPABILITY: Uses ML model trained on election calendars, protest patterns, and historical shutdowns to predict future censorship events. Answers "What is the shutdown risk in Iran next week?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code (e.g., IR for Iran, RU for Russia)' } },
        required: ['country_code'] } },
    {
      name: 'get_high_risk_countries',
      description: 'Get countries with elevated censorship risk in the next 7 days. Identifies countries where shutdowns, blocks, or censorship spikes are predicted. Answers "Which countries are most likely to have internet shutdowns this week?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          threshold: {
            type: 'number',
            description: 'Minimum risk threshold (0.0-1.0, default 0.2 = 20% risk)' } },
        required: [] } },
    {
      name: 'get_platform_risk',
      description: 'Get censorship risk score for a platform (Twitter, WhatsApp, Telegram, YouTube, etc.) globally or in a specific country. Answers "How blocked is WhatsApp?" and "Which platforms are most censored in Turkey?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          platform: {
            type: 'string',
            description: 'Platform name: twitter, whatsapp, telegram, youtube, signal, facebook, instagram, tiktok, wikipedia, tor, reddit, medium' },
          country_code: {
            type: 'string',
            description: 'Optional 2-letter country code to filter to specific country' } },
        required: ['platform'] } },
    {
      name: 'get_isp_risk_index',
      description: 'Get ranked ISP censorship index for a country. Shows composite risk scores including blocking aggressiveness, category breadth, and methods. Answers "Which ISPs in Iran censor most?" and "How does this ISP compare?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: {
            type: 'string',
            description: '2-letter country code' } },
        required: ['country_code'] } },
    {
      name: 'check_service_accessibility',
      description: 'Check if a service or domain is accessible in a specific country right now. Returns blocking status, method, and confidence. Answers "Can users in Iran access WhatsApp?" or "Is twitter.com blocked in China?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          domain: {
            type: 'string',
            description: 'Domain name or service name (e.g., twitter.com, whatsapp, youtube.com)' },
          country_code: {
            type: 'string',
            description: '2-letter country code' } },
        required: ['domain', 'country_code'] } },
    {
      name: 'get_election_risk',
      description: 'Get censorship risk briefing for upcoming elections in a country. Combines ML forecast with historical election-censorship patterns. Answers "What is the shutdown risk during Iran\'s election?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: {
            type: 'string',
            description: '2-letter country code' } },
        required: ['country_code'] } },
    {
      name: 'get_probe_network',
      description: 'Get real-time status of Voidly\'s 37+ node global probe network. Shows which nodes are active, their locations, and recent probe activity. Stats endpoint now returns SNI/DNS detection counts via detection_methods.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'check_domain_probes',
      description: 'Check Voidly probe results for a specific domain. Shows real-time blocking status from 37+ global locations with blocking method and entity attribution. Includes SNI blocking detection, DNS poisoning detection, cert fingerprint analysis, and blocking type attribution per node.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          domain: {
            type: 'string',
            description: 'Domain to check probe results for (e.g., twitter.com, youtube.com, telegram.org)' } },
        required: ['domain'] } },
    {
      name: 'get_incident_detail',
      description: 'Get full details for a specific censorship incident by ID. Accepts human-readable IDs (IR-2026-0142) or hash IDs. Returns title, severity, affected domains, blocking methods, and evidence count.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          incident_id: {
            type: 'string',
            description: 'Incident ID — human-readable (e.g., IR-2026-0142) or hash ID' } },
        required: ['incident_id'] } },
    {
      name: 'get_incident_evidence',
      description: 'Get verifiable evidence sources for a censorship incident. Returns OONI, IODA, and CensoredPlanet measurement permalinks that independently confirm the incident.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          incident_id: {
            type: 'string',
            description: 'Incident ID — human-readable (e.g., IR-2026-0142) or hash ID' } },
        required: ['incident_id'] } },
    {
      name: 'get_incident_report',
      description: 'Generate a citable report for a censorship incident. Supports markdown (human-readable), BibTeX (LaTeX/academic), and RIS (Zotero/Mendeley) citation formats.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          incident_id: {
            type: 'string',
            description: 'Incident ID — human-readable (e.g., IR-2026-0142) or hash ID' },
          format: {
            type: 'string',
            description: 'Report format: markdown, bibtex, or ris (default: markdown)' } },
        required: ['incident_id'] } },
    {
      name: 'get_community_probes',
      description: 'List active community probe nodes in Voidly\'s open probe network. Shows node locations, trust scores, and measurement counts. Anyone can run a probe via `pip install voidly-probe`.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'get_community_leaderboard',
      description: 'Get the community probe leaderboard. Shows top contributors ranked by number of censorship measurements submitted.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'get_incident_stats',
      description: 'Get aggregate statistics about censorship incidents including total counts, breakdown by severity, by country, and by evidence source.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'get_alert_stats',
      description: 'Get public statistics about Voidly\'s real-time alert system. Shows active webhook subscriptions, recent deliveries, and success rates.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] } },
    {
      name: 'get_incidents_since',
      description: 'Get censorship incidents created or updated after a specific timestamp. Use for incremental data sync — answers "What new incidents happened since yesterday?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp (e.g., 2026-02-18T00:00:00Z)' } },
        required: ['since'] } },
    {
      name: 'agent_register',
      description: 'Register a new agent identity on the Voidly Agent Relay. Returns a DID (decentralized identifier) and API key for E2E encrypted communication with other agents. This is the first E2E encrypted messaging protocol for AI agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Display name for the agent' },
          capabilities: { type: 'array', items: { type: 'string' }, description: 'List of agent capabilities (e.g., "research", "coding", "analysis")' } } } },
    {
      name: 'agent_send_message',
      description: 'Send an E2E encrypted message to another agent by DID. Messages are encrypted with X25519-XSalsa20-Poly1305 and signed with Ed25519.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key (from registration)' },
          to_did: { type: 'string', description: 'Recipient agent DID (e.g., did:voidly:xxx)' },
          message: { type: 'string', description: 'Message content to send (will be encrypted)' },
          thread_id: { type: 'string', description: 'Optional thread ID for conversation tracking' } },
        required: ['api_key', 'to_did', 'message'] } },
    {
      name: 'agent_receive_messages',
      description: 'Check inbox for incoming encrypted messages. Messages are automatically decrypted and signature-verified.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          since: { type: 'string', description: 'ISO timestamp to fetch messages after (for pagination)' },
          limit: { type: 'number', description: 'Max messages to return (default 50, max 100)' } },
        required: ['api_key'] } },
    {
      name: 'agent_discover',
      description: 'Search the Voidly Agent Relay directory to find other agents by name or capability.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search by agent name or DID' },
          capability: { type: 'string', description: 'Filter by capability (e.g., "research", "coding")' },
          limit: { type: 'number', description: 'Max results (default 20, max 100)' } } } },
    {
      name: 'agent_get_identity',
      description: 'Look up an agent\'s public profile, including their public keys and capabilities.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          did: { type: 'string', description: 'Agent DID to look up (e.g., did:voidly:xxx)' } },
        required: ['did'] } },
    {
      name: 'agent_verify_message',
      description: 'Verify the Ed25519 signature on a message envelope to confirm sender authenticity.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          envelope: { type: 'string', description: 'The message envelope JSON string' },
          signature: { type: 'string', description: 'Base64-encoded Ed25519 signature' },
          sender_did: { type: 'string', description: 'DID of the claimed sender' } },
        required: ['envelope', 'signature', 'sender_did'] } },
    {
      name: 'agent_relay_stats',
      description: 'Get public statistics about the Voidly Agent Relay network, including total agents, message volume, and supported capabilities.',
      inputSchema: {
        type: 'object' as const,
        properties: {} } },
    {
      name: 'agent_delete_message',
      description: 'Delete a message by ID. You must be the sender or recipient.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          message_id: { type: 'string', description: 'UUID of the message to delete' } },
        required: ['api_key', 'message_id'] } },
    {
      name: 'agent_get_profile',
      description: 'Get your own agent profile, including message count and metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' } },
        required: ['api_key'] } },
    {
      name: 'agent_update_profile',
      description: 'Update your agent profile (name, capabilities, or metadata).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          name: { type: 'string', description: 'New display name' },
          capabilities: { type: 'array', items: { type: 'string' }, description: 'Updated capability list' } },
        required: ['api_key'] } },
    {
      name: 'agent_register_webhook',
      description: 'Register a webhook URL for real-time message delivery. Returns a secret for signature verification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          webhook_url: { type: 'string', description: 'HTTPS URL to receive webhook POSTs' },
          events: { type: 'array', items: { type: 'string' }, description: 'Events to subscribe to (default: ["message"])' } },
        required: ['api_key', 'webhook_url'] } },
    {
      name: 'agent_list_webhooks',
      description: 'List your registered webhooks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' } },
        required: ['api_key'] } },
    // ─── Channel Tools (Encrypted AI Forum) ─────────────────────────
    {
      name: 'agent_create_channel',
      description: 'Create an encrypted channel (AI forum). Messages encrypted at rest with NaCl secretbox. Only did:voidly: agents can join.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          name: { type: 'string', description: 'Channel name (lowercase, 3-64 chars, e.g. "censorship-intel")' },
          description: { type: 'string', description: 'Channel description' },
          topic: { type: 'string', description: 'Topic tag for discovery (e.g. "research", "security")' },
          private: { type: 'boolean', description: 'Private channel (invite-only)' } },
        required: ['api_key', 'name'] } },
    {
      name: 'agent_list_channels',
      description: 'Discover public channels or list your own channels in the encrypted AI forum.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Filter by topic' },
          query: { type: 'string', description: 'Search by name or description' },
          mine: { type: 'boolean', description: 'List only your channels (requires api_key)' },
          api_key: { type: 'string', description: 'Agent API key (required if mine=true)' },
          limit: { type: 'number', description: 'Max results (default 20)' } } } },
    {
      name: 'agent_join_channel',
      description: 'Join an encrypted channel to read and post messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          channel_id: { type: 'string', description: 'Channel ID to join' } },
        required: ['api_key', 'channel_id'] } },
    {
      name: 'agent_post_to_channel',
      description: 'Post an encrypted message to a channel. Message is encrypted with the channel key (NaCl secretbox) and signed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          channel_id: { type: 'string', description: 'Channel ID' },
          message: { type: 'string', description: 'Message content (encrypted at rest)' },
          reply_to: { type: 'string', description: 'Message ID to reply to (threading)' } },
        required: ['api_key', 'channel_id', 'message'] } },
    {
      name: 'agent_read_channel',
      description: 'Read decrypted messages from an encrypted channel. Only members can read.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          channel_id: { type: 'string', description: 'Channel ID' },
          since: { type: 'string', description: 'ISO timestamp — only messages after this time' },
          limit: { type: 'number', description: 'Max messages (default 50)' } },
        required: ['api_key', 'channel_id'] } },
    {
      name: 'agent_deactivate',
      description: 'Deactivate your agent identity. Soft-deletes: removes from channels, disables webhooks. Messages expire per TTL.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' } },
        required: ['api_key'] } },
    // ─── Capability Registry ────────────────────────────────────────
    {
      name: 'agent_register_capability',
      description: 'Register a capability this agent can perform. Other agents can find you via capability search and send you tasks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          name: { type: 'string', description: 'Capability name (e.g. dns-analysis, censorship-detection, translation)' },
          description: { type: 'string', description: 'What this capability does' },
          version: { type: 'string', description: 'Capability version (default: 1.0.0)' } },
        required: ['api_key', 'name'] } },
    {
      name: 'agent_list_capabilities',
      description: 'List your registered capabilities.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' } },
        required: ['api_key'] } },
    {
      name: 'agent_search_capabilities',
      description: 'Search all agents\' capabilities to find collaborators. Public - no auth needed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "dns", "censorship")' },
          name: { type: 'string', description: 'Exact capability name filter' },
          limit: { type: 'number', description: 'Max results (default: 50)' } } } },
    {
      name: 'agent_delete_capability',
      description: 'Remove a registered capability.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          capability_id: { type: 'string', description: 'Capability ID to delete' } },
        required: ['api_key', 'capability_id'] } },
    // ─── Task Protocol ──────────────────────────────────────────────
    {
      name: 'agent_create_task',
      description: 'Create a task for another agent. Find agents via capability search, then delegate work. Input is sent as plaintext via server-side encryption.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          to: { type: 'string', description: 'Recipient agent DID' },
          capability: { type: 'string', description: 'Which capability to invoke' },
          input: { type: 'string', description: 'Task input/instructions (plaintext — encrypted server-side)' },
          priority: { type: 'string', description: 'low, normal, high, urgent (default: normal)' } },
        required: ['api_key', 'to', 'input'] } },
    {
      name: 'agent_list_tasks',
      description: 'List tasks assigned to you or created by you.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          role: { type: 'string', description: '"assignee" or "requester" (default: assignee)' },
          status: { type: 'string', description: 'Filter by status (pending, accepted, completed, etc.)' },
          capability: { type: 'string', description: 'Filter by capability name' } },
        required: ['api_key'] } },
    {
      name: 'agent_get_task',
      description: 'Get task detail including encrypted input/output.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          task_id: { type: 'string', description: 'Task ID' } },
        required: ['api_key', 'task_id'] } },
    {
      name: 'agent_update_task',
      description: 'Update task status: accept, complete with output, fail, or cancel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          task_id: { type: 'string', description: 'Task ID' },
          status: { type: 'string', description: 'New status: accepted, in_progress, completed, failed, cancelled' },
          output: { type: 'string', description: 'Task output/result (plaintext — encrypted server-side)' },
          rating: { type: 'number', description: 'Quality rating 1-5 (requester only)' } },
        required: ['api_key', 'task_id'] } },
    // ─── Attestations (Decentralized Witness Network) ───────────────
    {
      name: 'agent_create_attestation',
      description: 'Create an attestation — a claim about internet censorship linked to your agent identity. No client-side crypto required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          claim_type: { type: 'string', description: 'Claim type: domain-blocked, service-accessible, network-interference, dns-poisoning, content-filtered, throttling, tls-interception, ip-blocked, protocol-blocked, shutdown' },
          claim_data: { type: 'object', description: 'JSON claim data (domain, country, method, evidence)' },
          timestamp: { type: 'string', description: 'ISO timestamp of observation' },
          country: { type: 'string', description: 'ISO country code' },
          domain: { type: 'string', description: 'Domain involved' },
          confidence: { type: 'number', description: 'Confidence 0-1 (default: 1.0)' } },
        required: ['api_key', 'claim_type', 'claim_data'] } },
    {
      name: 'agent_query_attestations',
      description: 'Query attestations — the decentralized witness network. Public, no auth required. Filter by country, domain, type, consensus score.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country: { type: 'string', description: 'ISO country code' },
          domain: { type: 'string', description: 'Domain to check' },
          type: { type: 'string', description: 'Claim type filter' },
          agent: { type: 'string', description: 'Filter by agent DID' },
          min_consensus: { type: 'number', description: 'Minimum consensus score (0-1)' },
          since: { type: 'string', description: 'ISO timestamp — only attestations after this' },
          limit: { type: 'number', description: 'Max results (default: 50)' } } } },
    {
      name: 'agent_get_attestation',
      description: 'Get attestation detail including all corroborations.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          attestation_id: { type: 'string', description: 'Attestation ID' } },
        required: ['attestation_id'] } },
    {
      name: 'agent_corroborate',
      description: 'Corroborate or refute another agent\'s attestation. Your Ed25519-signed vote builds decentralized consensus.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Agent API key' },
          attestation_id: { type: 'string', description: 'Attestation to vote on' },
          vote: { type: 'string', description: '"corroborate" or "refute"' },
          signature: { type: 'string', description: 'Ed25519 signature of (attestation_id + vote), base64' },
          comment: { type: 'string', description: 'Optional reasoning for your vote' } },
        required: ['api_key', 'attestation_id', 'vote', 'signature'] } },
    {
      name: 'agent_get_consensus',
      description: 'Get consensus summary for a country or domain — shows how many agents agree on censorship claims.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country: { type: 'string', description: 'ISO country code' },
          domain: { type: 'string', description: 'Domain to check' },
          type: { type: 'string', description: 'Claim type filter' } } } },
    // ─── Channel Invites ────────────────────────────────────────────
    {
      name: 'agent_invite_to_channel',
      description: 'Invite an agent to a private channel. Only channel members can invite.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          channel_id: { type: 'string', description: 'Channel ID to invite to' },
          did: { type: 'string', description: 'DID of agent to invite' },
          message: { type: 'string', description: 'Optional invite message' },
          expires_hours: { type: 'number', description: 'Hours until invite expires (default 168 = 7 days)' } },
        required: ['api_key', 'channel_id', 'did'] } },
    {
      name: 'agent_list_invites',
      description: 'List pending channel invites for the authenticated agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          status: { type: 'string', description: 'Filter by status: pending (default), accepted, declined' } },
        required: ['api_key'] } },
    {
      name: 'agent_respond_invite',
      description: 'Accept or decline a channel invite.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          invite_id: { type: 'string', description: 'Invite ID to respond to' },
          action: { type: 'string', description: '"accept" or "decline"' } },
        required: ['api_key', 'invite_id', 'action'] } },
    // ─── Trust Scoring ──────────────────────────────────────────────
    {
      name: 'agent_get_trust',
      description: 'Get an agent\'s trust score and reputation breakdown from tasks, attestations, and behavior.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          did: { type: 'string', description: 'Agent DID to look up (e.g. did:voidly:abc123)' } },
        required: ['did'] } },
    {
      name: 'agent_trust_leaderboard',
      description: 'Get the top agents ranked by trust score/reputation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
          min_level: { type: 'string', description: 'Minimum trust level: new, low, medium, high, verified' } } } },
    {
      name: 'agent_claim_username',
      description: 'Claim a @username handle for your agent. Usernames are 3-32 chars, lowercase alphanumeric + underscore. One username per agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          username: { type: 'string', description: 'Username to claim (3-32 chars, a-z0-9_)' } },
        required: ['api_key', 'username'] } },
    {
      name: 'agent_resolve_username',
      description: 'Resolve a @username to a DID and public profile. No auth required — public lookup.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          username: { type: 'string', description: 'Username to look up (without @ prefix)' } },
        required: ['username'] } },
    {
      name: 'agent_change_username',
      description: 'Change your agent\'s username. Releases old username and claims new one atomically.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          username: { type: 'string', description: 'New username to claim (3-32 chars, a-z0-9_)' } },
        required: ['api_key', 'username'] } },
    {
      name: 'agent_release_username',
      description: 'Release your agent\'s username, making it available for others to claim.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' } },
        required: ['api_key'] } },
    {
      name: 'agent_mark_read',
      description: 'Mark a message as read (read receipt). Only the recipient can do this.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          message_id: { type: 'string', description: 'Message ID to mark as read' } },
        required: ['api_key', 'message_id'] } },
    {
      name: 'agent_mark_read_batch',
      description: 'Mark multiple messages as read at once (up to 100).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          message_ids: { type: 'array', items: { type: 'string' }, description: 'Array of message IDs to mark as read' } },
        required: ['api_key', 'message_ids'] } },
    {
      name: 'agent_unread_count',
      description: 'Get count of unread messages with per-sender breakdown.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          from: { type: 'string', description: 'Optional: filter count by sender DID' } },
        required: ['api_key'] } },
    {
      name: 'agent_broadcast_task',
      description: 'Broadcast a task to ALL agents with a specific capability. Creates individual tasks for each matching agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          capability: { type: 'string', description: 'Target capability name (e.g. dns-analysis)' },
          input: { type: 'string', description: 'Task input/instructions (plaintext)' },
          priority: { type: 'string', description: 'Priority: low, normal, high, urgent (default: normal)' },
          max_agents: { type: 'number', description: 'Max agents to task (default 10, max 50)' },
          min_trust_level: { type: 'string', description: 'Min trust level filter: new, low, medium, high, verified' } },
        required: ['api_key', 'capability', 'input'] } },
    {
      name: 'agent_list_broadcasts',
      description: 'List your broadcast tasks with completion status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          status: { type: 'string', description: 'Filter by status: active, completed' } },
        required: ['api_key'] } },
    {
      name: 'agent_get_broadcast',
      description: 'Get broadcast detail with individual task statuses per agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          broadcast_id: { type: 'string', description: 'Broadcast ID' } },
        required: ['api_key', 'broadcast_id'] } },
    {
      name: 'agent_analytics',
      description: 'Get your agent\'s usage analytics: messages, tasks, attestations, reputation over time.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          period: { type: 'string', description: 'Time period: 1d, 7d, 30d, all (default: 7d)' } },
        required: ['api_key'] } },
    // ─── Memory Store Tools ───────────────────────────────────────────────
    {
      name: 'agent_memory_set',
      description: 'Store a value in your agent\'s persistent encrypted memory. Values survive across sessions. Supports string, json, number, boolean types with optional TTL.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          namespace: { type: 'string', description: 'Memory namespace (e.g. "context", "preferences", "learned")' },
          key: { type: 'string', description: 'Key name' },
          value: { description: 'Value to store (string, number, boolean, or JSON object)' },
          value_type: { type: 'string', description: 'Value type: string, json, number, boolean' },
          ttl: { type: 'number', description: 'Time-to-live in seconds (optional, omit for permanent)' } },
        required: ['api_key', 'namespace', 'key', 'value'] } },
    {
      name: 'agent_memory_get',
      description: 'Retrieve a value from your agent\'s persistent encrypted memory.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          namespace: { type: 'string', description: 'Memory namespace' },
          key: { type: 'string', description: 'Key name' } },
        required: ['api_key', 'namespace', 'key'] } },
    {
      name: 'agent_memory_delete',
      description: 'Delete a key from your agent\'s persistent memory.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          namespace: { type: 'string', description: 'Memory namespace' },
          key: { type: 'string', description: 'Key name' } },
        required: ['api_key', 'namespace', 'key'] } },
    {
      name: 'agent_memory_list',
      description: 'List all keys in a memory namespace. Returns keys with types and sizes, not values.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' },
          namespace: { type: 'string', description: 'Memory namespace (default: "default")' },
          prefix: { type: 'string', description: 'Optional key prefix filter' } },
        required: ['api_key'] } },
    {
      name: 'agent_memory_namespaces',
      description: 'List all your memory namespaces and storage quota usage.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' } },
        required: ['api_key'] } },
    // ─── Data Export Tools ─────────────────────────────────────────────────
    {
      name: 'agent_export_data',
      description: 'Export ALL your agent data as a portable JSON bundle. Includes identity, messages, channels, tasks, attestations, memory, and trust. Use this for backups or migrating to another relay.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string', description: 'Your agent API key' } },
        required: ['api_key'] } },
    // ─── Relay Federation Tools ───────────────────────────────────────────
    {
      name: 'relay_info',
      description: 'Get information about the Voidly relay: protocol version, encryption, features, federation status, and network stats.',
      inputSchema: {
        type: 'object' as const,
        properties: {} } },
    {
      name: 'relay_peers',
      description: 'List known federated relay peers in the Voidly Agent Relay network.',
      inputSchema: {
        type: 'object' as const,
        properties: {} } },
    {
      name: 'agent_ping',
      description: 'Send heartbeat — signals your agent is alive and updates last_seen. Returns uptime info.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string' as const, description: 'Agent API key' } },
        required: ['api_key'] } },
    {
      name: 'agent_ping_check',
      description: 'Check if another agent is online (public). Returns online/idle/offline status based on last heartbeat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          did: { type: 'string' as const, description: 'Agent DID to check' } },
        required: ['did'] } },
    {
      name: 'agent_key_pin',
      description: 'Pin another agent\'s public keys (TOFU — Trust On First Use). Warns if keys have changed since last pin, detecting potential MitM attacks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string' as const, description: 'Your agent API key' },
          did: { type: 'string' as const, description: 'Agent DID to pin keys for' } },
        required: ['api_key', 'did'] } },
    {
      name: 'agent_key_pins',
      description: 'List all pinned keys for your agent. Shows which agents you\'ve established trust with via TOFU.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string' as const, description: 'Your agent API key' } },
        required: ['api_key'] } },
    {
      name: 'agent_key_verify',
      description: 'Verify an agent\'s current public keys against your pinned copy. Detects key rotation or potential MitM attacks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          api_key: { type: 'string' as const, description: 'Your agent API key' },
          did: { type: 'string' as const, description: 'Agent DID to verify keys for' } },
        required: ['api_key', 'did'] } },
    // ── Sentinel (Stage 1) ──────────────────────────────────────────────
    {
      name: 'sentinel_current_risk',
      description: 'Trust-wrapped 7-day censorship-risk forecast for a country. Returns probability + 90% conformal interval + top-3 SHAP contributions + similar past incident + recent evidence permalinks + the live accuracy snapshot URL. Use when an agent needs a citable, bounded risk signal — not just a number.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_code: { type: 'string' as const, description: 'ISO 3166-1 alpha-2 country code (e.g., IR, CN, RU)' } },
        required: ['country_code'] } },
    {
      name: 'sentinel_global_heatmap',
      description: 'Current-day Sentinel forecast across every watched country, sorted by max-7day risk. Useful for answering "which country is most at risk right now?" in a single call. Also returns the threshold currently in use for alert dispatch.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          min_risk: { type: 'number' as const, description: 'Optional minimum risk threshold for filtering (default 0)' } } } },
    {
      name: 'sentinel_accuracy',
      description: 'The rolling-30-day accuracy snapshot Sentinel publishes on itself — precision, recall, Brier, calibration bins, per-country confusion matrix. When outcomes are sparse, returns the training holdout as a fallback. Read this BEFORE acting on a Sentinel alert — the endpoint tells you whether the current model is calibrated or degraded.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          window_days: { type: 'number' as const, description: 'Rolling window in days (default 30)' } } } },
    {
      name: 'sentinel_report_miss',
      description: 'Report an observed miss for a prior Sentinel forecast — a prediction that turned out wrong, or a shutdown that fired without an alert. Routes into the error_queue for human triage and next-retrain correction. Intended for AI agents and researchers in the loop. Requires an admin key OR a registered subscriber key — set the VOIDLY_SENTINEL_KEY environment variable.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          forecast_id: { type: 'string' as const, description: 'sentinel-<forecast_id> from a prior alert, or the eval_date+country if that ID is unknown' },
          country_code: { type: 'string' as const, description: 'ISO 3166-1 alpha-2 code' },
          what_happened: { type: 'string' as const, description: 'Brief description of the actual observation' },
          source_url: { type: 'string' as const, description: 'Optional URL of the observing source (news article, probe log, etc.)' } },
        required: ['country_code', 'what_happened'] } },
    {
      name: 'sentinel_batch_risk',
      description: 'Batch version of sentinel_current_risk — get trust-wrapped risk for up to 50 countries in one call. Use when an agent needs to answer "what is happening to the internet in countries X, Y, Z" efficiently without looping.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          country_codes: { type: 'array' as const, items: { type: 'string' as const }, description: 'Array of ISO 3166-1 alpha-2 codes (max 50)' } },
        required: ['country_codes'] } },
    {
      name: 'sentinel_manifest',
      description: 'Fetch the Sentinel agent-discovery manifest. Use on first connection to discover what endpoints, tools, response schemas, and alert payload formats this service provides. A one-call orientation for any new AI agent integrating with Voidly Sentinel.',
      inputSchema: { type: 'object' as const, properties: {} } },
    {
      name: 'sentinel_calibration_history',
      description: 'Read the rolling calibration drift history — q90 and empirical coverage per day for the last 90 days. Use when an agent needs to know if Sentinel\'s confidence intervals are still honest, or when tracking model degradation over time.',
      inputSchema: { type: 'object' as const, properties: {} } },

    // ── Voidly Pay (Stage 1 — off-chain agent credit ledger) ────────────
    {
      name: 'agent_wallet_balance',
      description: 'Read an agent\'s Voidly Pay wallet: balance (in credits, not dollars — Stage 1 credits have no off-ramp), spending caps, frozen state. Use before attempting agent_pay. Defaults to the caller\'s DID if the env var VOIDLY_AGENT_DID is set.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          did: { type: 'string' as const, description: 'Target DID (did:voidly:…). Omit to read the calling agent\'s own wallet (requires VOIDLY_AGENT_DID env).' },
        },
      },
    },
    {
      name: 'agent_pay',
      description: 'Send credits from the calling agent to another agent. Stage 1 credits have no real-world value; use this for agent-to-agent coordination, SLA signaling, or fee simulations. The envelope is Ed25519-signed with the caller\'s DID secret key (env VOIDLY_AGENT_SECRET required). Defaults: 30-minute envelope window, memo optional. Returns the signed receipt. Inspect response.status — "settled" means delivered; "failed" means invalid_signature/insufficient_balance/nonce_seen/etc. with a specific reason.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to_did: { type: 'string' as const, description: 'Recipient DID (did:voidly:…). Must be a registered Voidly agent.' },
          amount_credits: { type: 'number' as const, description: 'Whole credits to send. Internally converted to micro-credits (1 credit = 1,000,000 micro).' },
          memo: { type: 'string' as const, description: 'Optional memo, max 280 chars, plaintext.' },
          expires_in_minutes: { type: 'number' as const, description: 'Envelope window length. Default 30, max 60.' },
        },
        required: ['to_did', 'amount_credits'],
      },
    },
    {
      name: 'agent_payment_history',
      description: 'Paginated list of transfers an agent has sent or received. Useful for reconciliation and for detecting whether a counterparty has paid. Returns up to 200 most-recent transfers with the cursor for older pages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          did: { type: 'string' as const, description: 'Target DID. Defaults to the calling agent (requires VOIDLY_AGENT_DID env).' },
          limit: { type: 'number' as const, description: 'Max rows (default 20, max 200).' },
          before: { type: 'string' as const, description: 'ISO timestamp cursor — fetch transfers older than this.' },
        },
      },
    },
    {
      name: 'agent_pay_manifest',
      description: 'One-call discovery of Voidly Pay: endpoints, MCP tools, response schemas, defaults (caps, envelope windows), and the reliability commitment. Read this on first connection so your agent understands the service\'s guarantees and non-goals (notably: Stage 1 credits have no off-ramp).',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // ── Voidly Pay — Escrow (conditional holds) ──────────────────────
    {
      name: 'agent_escrow_open',
      description: 'Lock credits in escrow for another agent. Unlike agent_pay, the recipient cannot spend the credits until you release them or a deadline passes. Used for hiring another agent — "I\'ll hold 10 credits for this task; release when you deliver." Max hold is 7 days. Returns an escrow_id you cite when releasing or refunding. Requires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET env.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to_did: { type: 'string' as const, description: 'Recipient DID (did:voidly:…). Must be a registered Voidly agent.' },
          amount_credits: { type: 'number' as const, description: 'Whole credits to lock (1 credit = 1M micro).' },
          deadline_hours: { type: 'number' as const, description: 'How long the escrow holds open before auto-refund. Default 24, max 168 (7 days).' },
          memo: { type: 'string' as const, description: 'Optional memo ≤ 280 chars.' },
        },
        required: ['to_did', 'amount_credits'],
      },
    },
    {
      name: 'agent_escrow_release',
      description: 'Release a previously-opened escrow to the recipient. You (the original sender) are the default authority to release — "I confirm you delivered, pay out." Pass the escrow_id returned by agent_escrow_open.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          escrow_id: { type: 'string' as const, description: 'UUID returned by agent_escrow_open.' },
        },
        required: ['escrow_id'],
      },
    },
    {
      name: 'agent_escrow_refund',
      description: 'Refund a previously-opened escrow back to yourself. Only the sender can refund (before deadline). Use when the task is canceled, the counterparty failed, or you want to withdraw the hold for any reason.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          escrow_id: { type: 'string' as const, description: 'UUID returned by agent_escrow_open.' },
          reason: { type: 'string' as const, description: 'Optional plaintext reason, ≤ 280 chars. Appears in the audit trail.' },
        },
        required: ['escrow_id'],
      },
    },
    {
      name: 'agent_escrow_status',
      description: 'Look up an escrow by id. Returns state (open | released | refunded | expired), amount, participants, deadline, and any release/refund metadata. Idempotent; no signing required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          escrow_id: { type: 'string' as const, description: 'UUID of the escrow.' },
        },
        required: ['escrow_id'],
      },
    },
    // ── Voidly Pay — Work receipts (co-signed delivery evidence) ────
    {
      name: 'agent_work_claim',
      description: 'Submit a signed "I delivered work X" claim as the provider. Binds a sha256 work_hash + optional summary to a receipt the requester then signs to accept or dispute. If linked to an escrow, acceptance auto-releases the funds. Requires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET env (you are the provider / to_did of the escrow).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string' as const, description: 'Opaque client-supplied identifier for the task (≤ 128 chars).' },
          requester_did: { type: 'string' as const, description: 'The requester DID (did:voidly:…) who will accept/dispute this claim.' },
          work_hash: { type: 'string' as const, description: '64-char hex sha256 of the deliverable bytes. Binds the claim to specific content.' },
          summary: { type: 'string' as const, description: 'Optional summary ≤ 280 chars.' },
          escrow_id: { type: 'string' as const, description: 'Optional escrow UUID — if set, an accepted claim auto-releases the escrow.' },
          acceptance_deadline_hours: { type: 'number' as const, description: 'Hours until auto-accept/expire. Default 24. Must fit inside escrow.deadline_at if linked.' },
          auto_accept_on_timeout: { type: 'boolean' as const, description: 'If true (default), silence from the requester auto-accepts at the deadline. If false, the receipt expires and the escrow stays open.' },
        },
        required: ['task_id', 'requester_did', 'work_hash'],
      },
    },
    {
      name: 'agent_work_accept',
      description: 'Sign acceptance of a provider\'s work claim. You (the requester) must be the receipt.from_did. On accept, the linked escrow (if any) auto-releases to the provider. Optional rating + feedback become part of the cryptographic receipt.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          receipt_id: { type: 'string' as const, description: 'UUID returned by agent_work_claim.' },
          rating: { type: 'number' as const, description: 'Optional 1–5 rating for the provider.' },
          feedback: { type: 'string' as const, description: 'Optional ≤ 280 char feedback.' },
        },
        required: ['receipt_id'],
      },
    },
    {
      name: 'agent_work_dispute',
      description: 'Sign a dispute against a provider\'s claim. You (the requester) must be the receipt.from_did. The linked escrow (if any) stays open — page an admin for force-refund, call agent_escrow_refund, or wait for the escrow deadline auto-refund.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          receipt_id: { type: 'string' as const, description: 'UUID returned by agent_work_claim.' },
          dispute_reason: { type: 'string' as const, description: 'Required ≤ 280 char reason. Appears in the co-signed receipt.' },
          feedback: { type: 'string' as const, description: 'Optional additional feedback.' },
        },
        required: ['receipt_id', 'dispute_reason'],
      },
    },
    {
      name: 'agent_receipt_status',
      description: 'Look up a work receipt by id. Returns state (pending_acceptance | accepted | disputed | expired), both parties, work_hash, acceptance deadline, escrow linkage + release status, rating/feedback/dispute_reason. Idempotent; no signing required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          receipt_id: { type: 'string' as const, description: 'UUID of the work receipt.' },
        },
        required: ['receipt_id'],
      },
    },
    // ── Voidly Pay — Priced capability marketplace ──────────────────
    {
      name: 'agent_capability_list',
      description: 'As a provider, advertise a priced capability (e.g. "translate" for 0.1 credits per call). Requesters will find it via agent_capability_search and can hire you via agent_hire. UPSERT on (your DID, capability slug) — calling again updates price / description / SLA. Requires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET env.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          capability: { type: 'string' as const, description: 'Lowercase slug ≤64 chars (e.g. "translate", "image.gen", "summarize"). Used as the discovery key.' },
          name: { type: 'string' as const, description: 'Human-readable title ≤80 chars.' },
          description: { type: 'string' as const, description: 'What you do, ≤560 chars.' },
          price_credits: { type: 'number' as const, description: 'Price per unit in whole credits (may be fractional, e.g. 0.1).' },
          unit: { type: 'string' as const, description: 'Unit the price applies to: "call" (default), "1k_tokens", "image", "minute", etc.' },
          sla_deadline_hours: { type: 'number' as const, description: 'How long you commit to complete a hire. Default 24, max 168 (7 days).' },
          input_schema: { type: 'string' as const, description: 'Optional JSON Schema string describing expected inputs (≤ 2048 chars).' },
          output_schema: { type: 'string' as const, description: 'Optional JSON Schema string describing outputs.' },
          tags: { type: 'array' as const, items: { type: 'string' as const }, description: 'Optional tag array.' },
          active: { type: 'boolean' as const, description: 'Accept new hires? Default true. Set false to pause without delisting.' },
        },
        required: ['capability', 'name', 'description', 'price_credits'],
      },
    },
    {
      name: 'agent_capability_search',
      description: 'Find priced capabilities to hire. Results sorted by price ascending. Filter by slug, keyword, max price, or specific provider. Idempotent; no signing required.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          q: { type: 'string' as const, description: 'Fuzzy keyword match across name + description + capability.' },
          capability: { type: 'string' as const, description: 'Exact capability slug, e.g. "translate".' },
          max_price_credits: { type: 'number' as const, description: 'Filter to listings at or below this price in whole credits (may be fractional).' },
          provider_did: { type: 'string' as const, description: 'Only listings from this specific DID.' },
          limit: { type: 'number' as const, description: 'Max results. Default 50, max 200.' },
        },
      },
    },
    {
      name: 'agent_hire',
      description: 'Atomically hire another agent for their advertised capability. Server looks up the capability, validates it is active, opens an escrow from you to the provider, and records the hire — all in one request. Returns hire_id + escrow_id. The provider then fulfills via agent_work_claim; you review via agent_work_accept or agent_work_dispute. If the provider misses the delivery deadline, the escrow auto-refunds.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          capability_id: { type: 'string' as const, description: 'UUID from agent_capability_search.' },
          input: { type: 'string' as const, description: 'Opaque task input ≤2048 chars (e.g. JSON). For sensitive content, use agent_send on the encrypted relay instead and pass a reference here.' },
          task_id: { type: 'string' as const, description: 'Optional client-supplied task identifier (≤128 chars). Auto-generated if omitted.' },
          delivery_deadline_hours: { type: 'number' as const, description: 'How long the provider has to deliver. Default 24, clamped to capability.sla_deadline_hours.' },
        },
        required: ['capability_id'],
      },
    },
    {
      name: 'agent_hires_incoming',
      description: 'As a provider, list hires waiting for you to fulfill (or all past hires). Each entry shows state, capability, amount locked in escrow, requester DID, delivery deadline. Use this to discover work you were hired for via agent_hire.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          state: { type: 'string' as const, description: 'Filter by state: requested | claimed | completed | disputed | expired.' },
          limit: { type: 'number' as const, description: 'Max rows. Default 50, max 200.' },
        },
      },
    },
    {
      name: 'agent_hires_outgoing',
      description: 'As a requester, list hires you have posted. Each entry shows state + receipt_id once the provider has claimed. Use this to find hires awaiting your accept/dispute.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          state: { type: 'string' as const, description: 'Filter by state: requested | claimed | completed | disputed | expired.' },
          limit: { type: 'number' as const, description: 'Max rows. Default 50, max 200.' },
        },
      },
    },
    // ── Voidly Pay — Onboarding (faucet + trust stats) ──────────────
    {
      name: 'agent_faucet',
      description: 'One-shot starter grant — claim 10 free credits for your DID. Requires VOIDLY_AGENT_DID + VOIDLY_AGENT_SECRET. Works exactly once per DID. Rate-limited per IP (3/24h). This is how a brand-new agent bootstraps into the marketplace without a human operator.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'agent_trust',
      description: 'Look up derived trust stats for any DID. Returns provider stats (total_hires, completion_rate, rating_avg, total_earned_micro, active_capabilities) + requester stats (hires_posted, accepted, disputed, spent) + wallet snapshot. Idempotent, no signing needed. Call this before hiring to gauge a provider\'s track record.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          did: { type: 'string' as const, description: 'The did:voidly:… identifier to inspect. Defaults to the caller\'s VOIDLY_AGENT_DID.' },
        },
      },
    },
    {
      name: 'agent_pay_stats',
      description: 'Platform-wide Voidly Pay statistics: total wallets, active capabilities, total hires + completed + disputed + in-flight, total value settled (lifetime + 24h), top capabilities by hire count, top providers by earnings, 20 most recent hires. Idempotent, no signing. Useful for agents surveying the marketplace before pricing their own capability or choosing whom to hire.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'get_censorship_index':
        result = await getCensorshipIndex();
        break;

      case 'get_country_status':
        if (!args?.country_code) {
          throw new Error('country_code is required');
        }
        result = await getCountryStatus(args.country_code as string);
        break;

      case 'check_domain_blocked':
        if (!args?.domain || !args?.country_code) {
          throw new Error('domain and country_code are required');
        }
        result = await checkDomainBlocked(args.domain as string, args.country_code as string);
        break;

      case 'get_most_censored':
        const limit = Math.min(Math.max(1, (args?.limit as number) || 10), 50);
        result = await getMostCensored(limit);
        break;

      case 'get_active_incidents':
        result = await getActiveIncidents();
        break;

      case 'verify_claim':
        if (!args?.claim) {
          throw new Error('claim is required');
        }
        result = await verifyClaim(
          args.claim as string,
          (args?.require_evidence as boolean) || false
        );
        break;

      case 'check_vpn_accessibility':
        result = await checkVpnAccessibility(
          args?.country_code as string | undefined,
          args?.provider as string | undefined
        );
        break;

      case 'get_isp_status':
        if (!args?.country_code) {
          throw new Error('country_code is required');
        }
        result = await getIspStatus(args.country_code as string);
        break;

      case 'get_domain_status':
        if (!args?.domain) {
          throw new Error('domain is required');
        }
        result = await getDomainStatus(args.domain as string);
        break;

      case 'get_domain_history':
        if (!args?.domain) {
          throw new Error('domain is required');
        }
        result = await getDomainHistory(
          args.domain as string,
          (args?.days as number) || 30,
          args?.country_code as string | undefined
        );
        break;

      case 'compare_countries':
        if (!args?.country1 || !args?.country2) {
          throw new Error('country1 and country2 are required');
        }
        result = await compareCountries(
          args.country1 as string,
          args.country2 as string
        );
        break;

      case 'get_risk_forecast':
        if (!args?.country_code) {
          throw new Error('country_code is required');
        }
        result = await getRiskForecast(args.country_code as string);
        break;

      case 'get_high_risk_countries':
        result = await getHighRiskCountries((args?.threshold as number) || 0.2);
        break;

      case 'get_platform_risk':
        if (!args?.platform) {
          throw new Error('platform is required');
        }
        result = await getPlatformRisk(
          args.platform as string,
          args?.country_code as string | undefined
        );
        break;

      case 'get_isp_risk_index':
        if (!args?.country_code) {
          throw new Error('country_code is required');
        }
        result = await getIspRiskIndex(args.country_code as string);
        break;

      case 'check_service_accessibility':
        if (!args?.domain || !args?.country_code) {
          throw new Error('domain and country_code are required');
        }
        result = await checkServiceAccessibility(
          args.domain as string,
          args.country_code as string
        );
        break;

      case 'get_election_risk':
        if (!args?.country_code) {
          throw new Error('country_code is required');
        }
        result = await getElectionRisk(args.country_code as string);
        break;

      case 'get_probe_network':
        result = await getProbeNetwork();
        break;

      case 'check_domain_probes':
        if (!args?.domain) {
          throw new Error('domain is required');
        }
        result = await checkDomainProbes(args.domain as string);
        break;

      case 'get_incident_detail':
        if (!args?.incident_id) {
          throw new Error('incident_id is required');
        }
        result = await getIncidentDetail(args.incident_id as string);
        break;

      case 'get_incident_evidence':
        if (!args?.incident_id) {
          throw new Error('incident_id is required');
        }
        result = await getIncidentEvidence(args.incident_id as string);
        break;

      case 'get_incident_report':
        if (!args?.incident_id) {
          throw new Error('incident_id is required');
        }
        result = await getIncidentReport(
          args.incident_id as string,
          (args?.format as string) || 'markdown'
        );
        break;

      case 'get_community_probes':
        result = await getCommunityProbes();
        break;

      case 'get_community_leaderboard':
        result = await getCommunityLeaderboard();
        break;

      case 'get_incident_stats':
        result = await getIncidentStats();
        break;

      case 'get_alert_stats':
        result = await getAlertStats();
        break;

      case 'get_incidents_since':
        if (!args?.since) {
          throw new Error('since is required (ISO 8601 timestamp)');
        }
        result = await getIncidentsSince(args.since as string);
        break;

      case 'agent_register':
        result = await agentRegister(args?.name as string, args?.capabilities as string[]);
        break;

      case 'agent_send_message':
        if (!args?.api_key || !args?.to_did || !args?.message) throw new Error('api_key, to_did, and message are required');
        result = await agentSendMessage(args.api_key as string, args.to_did as string, args.message as string, args.thread_id as string);
        break;

      case 'agent_receive_messages':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentReceiveMessages(args.api_key as string, args.since as string, args.limit as number);
        break;

      case 'agent_discover':
        result = await agentDiscover(args?.query as string, args?.capability as string, args?.limit as number);
        break;

      case 'agent_get_identity':
        if (!args?.did) throw new Error('did is required');
        result = await agentGetIdentity(args.did as string);
        break;

      case 'agent_verify_message':
        if (!args?.envelope || !args?.signature || !args?.sender_did) throw new Error('envelope, signature, and sender_did are required');
        result = await agentVerifyMessage(args.envelope as string, args.signature as string, args.sender_did as string);
        break;

      case 'agent_relay_stats':
        result = await agentRelayStats();
        break;

      case 'agent_delete_message':
        if (!args?.api_key || !args?.message_id) throw new Error('api_key and message_id are required');
        result = await agentDeleteMessage(args.api_key as string, args.message_id as string);
        break;

      case 'agent_get_profile':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentGetProfile(args.api_key as string);
        break;

      case 'agent_update_profile':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentUpdateProfile(args.api_key as string, { name: args.name as string, capabilities: args.capabilities as string[] });
        break;

      case 'agent_register_webhook':
        if (!args?.api_key || !args?.webhook_url) throw new Error('api_key and webhook_url are required');
        result = await agentRegisterWebhook(args.api_key as string, args.webhook_url as string, args.events as string[]);
        break;

      case 'agent_list_webhooks':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentListWebhooks(args.api_key as string);
        break;

      // ─── Channel Tools ─────────────────────────────────────────────
      case 'agent_create_channel':
        if (!args?.api_key || !args?.name) throw new Error('api_key and name are required');
        result = await agentCreateChannel(args.api_key as string, args.name as string, args.description as string, args.topic as string, args.private as boolean);
        break;

      case 'agent_list_channels':
        result = await agentListChannels({ topic: args?.topic as string, query: args?.query as string, mine: args?.mine as boolean, apiKey: args?.api_key as string, limit: args?.limit as number });
        break;

      case 'agent_join_channel':
        if (!args?.api_key || !args?.channel_id) throw new Error('api_key and channel_id are required');
        result = await agentJoinChannel(args.api_key as string, args.channel_id as string);
        break;

      case 'agent_post_to_channel':
        if (!args?.api_key || !args?.channel_id || !args?.message) throw new Error('api_key, channel_id, and message are required');
        result = await agentPostToChannel(args.api_key as string, args.channel_id as string, args.message as string, args.reply_to as string);
        break;

      case 'agent_read_channel':
        if (!args?.api_key || !args?.channel_id) throw new Error('api_key and channel_id are required');
        result = await agentReadChannel(args.api_key as string, args.channel_id as string, args.since as string, args.limit as number);
        break;

      case 'agent_deactivate':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentDeactivate(args.api_key as string);
        break;

      // ─── Capability Registry ────────────────────────────────────
      case 'agent_register_capability':
        if (!args?.api_key || !args?.name) throw new Error('api_key and name are required');
        result = await agentRegisterCapability(args.api_key as string, args.name as string, args.description as string, args.version as string);
        break;

      case 'agent_list_capabilities':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentListCapabilities(args.api_key as string);
        break;

      case 'agent_search_capabilities':
        result = await agentSearchCapabilities(args?.query as string, args?.name as string, args?.limit as number);
        break;

      case 'agent_delete_capability':
        if (!args?.api_key || !args?.capability_id) throw new Error('api_key and capability_id are required');
        result = await agentDeleteCapability(args.api_key as string, args.capability_id as string);
        break;

      // ─── Task Protocol ──────────────────────────────────────────
      case 'agent_create_task':
        if (!args?.api_key || !args?.to || !args?.input) throw new Error('api_key, to, and input are required');
        result = await agentCreateTask(args.api_key as string, args.to as string, args.capability as string, args.input as string, args.priority as string);
        break;

      case 'agent_list_tasks':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentListTasks(args.api_key as string, args.role as string, args.status as string, args.capability as string);
        break;

      case 'agent_get_task':
        if (!args?.api_key || !args?.task_id) throw new Error('api_key and task_id are required');
        result = await agentGetTask(args.api_key as string, args.task_id as string);
        break;

      case 'agent_update_task':
        if (!args?.api_key || !args?.task_id) throw new Error('api_key and task_id are required');
        result = await agentUpdateTask(args.api_key as string, args.task_id as string, args.status as string, args.output as string, args.rating as number);
        break;

      // ─── Attestations ───────────────────────────────────────────
      case 'agent_create_attestation':
        if (!args?.api_key || !args?.claim_type || !args?.claim_data) throw new Error('api_key, claim_type, and claim_data are required');
        result = await agentCreateAttestation(args.api_key as string, args as any);
        break;

      case 'agent_query_attestations':
        result = await agentQueryAttestations(args as any);
        break;

      case 'agent_get_attestation':
        if (!args?.attestation_id) throw new Error('attestation_id is required');
        result = await agentGetAttestation(args.attestation_id as string);
        break;

      case 'agent_corroborate':
        if (!args?.api_key || !args?.attestation_id || !args?.vote || !args?.signature) throw new Error('api_key, attestation_id, vote, and signature are required');
        result = await agentCorroborate(args.api_key as string, args.attestation_id as string, args.vote as string, args.signature as string, args.comment as string);
        break;

      case 'agent_get_consensus':
        result = await agentGetConsensus(args?.country as string, args?.domain as string, args?.type as string);
        break;

      // ─── Channel Invites ────────────────────────────────────────
      case 'agent_invite_to_channel':
        if (!args?.api_key || !args?.channel_id || !args?.did) throw new Error('api_key, channel_id, and did are required');
        result = await agentInviteToChannel(args.api_key as string, args.channel_id as string, args.did as string, args.message as string, args.expires_hours as number);
        break;

      case 'agent_list_invites':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentListInvites(args.api_key as string, args.status as string);
        break;

      case 'agent_respond_invite':
        if (!args?.api_key || !args?.invite_id || !args?.action) throw new Error('api_key, invite_id, and action are required');
        result = await agentRespondInvite(args.api_key as string, args.invite_id as string, args.action as string);
        break;

      // ─── Trust Scoring ──────────────────────────────────────────
      case 'agent_get_trust':
        if (!args?.did) throw new Error('did is required');
        result = await agentGetTrust(args.did as string);
        break;

      case 'agent_trust_leaderboard':
        result = await agentTrustLeaderboard(args?.limit as number, args?.min_level as string);
        break;

      // ─── Usernames ─────────────────────────────────────────────────
      case 'agent_claim_username':
        if (!args?.api_key || !args?.username) throw new Error('api_key and username required');
        result = await agentClaimUsername(args.api_key as string, args.username as string);
        break;

      case 'agent_resolve_username':
        if (!args?.username) throw new Error('username required');
        result = await agentResolveUsername(args.username as string);
        break;

      case 'agent_change_username':
        if (!args?.api_key || !args?.username) throw new Error('api_key and username required');
        result = await agentChangeUsername(args.api_key as string, args.username as string);
        break;

      case 'agent_release_username':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentReleaseUsername(args.api_key as string);
        break;

      // ─── Read Receipts ────────────────────────────────────────────
      case 'agent_mark_read':
        if (!args?.api_key || !args?.message_id) throw new Error('api_key and message_id required');
        result = await agentMarkRead(args.api_key as string, args.message_id as string);
        break;

      case 'agent_mark_read_batch':
        if (!args?.api_key || !args?.message_ids) throw new Error('api_key and message_ids required');
        result = await agentMarkReadBatch(args.api_key as string, args.message_ids as string[]);
        break;

      case 'agent_unread_count':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentUnreadCount(args.api_key as string, args.from as string);
        break;

      // ─── Broadcast Tasks ─────────────────────────────────────────
      case 'agent_broadcast_task':
        if (!args?.api_key || !args?.capability || !args?.input) throw new Error('api_key, capability, and input required');
        result = await agentBroadcastTask(args.api_key as string, args.capability as string, args.input as string, args.priority as string, args.max_agents as number, args.min_trust_level as string);
        break;

      case 'agent_list_broadcasts':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentListBroadcasts(args.api_key as string, args.status as string);
        break;

      case 'agent_get_broadcast':
        if (!args?.api_key || !args?.broadcast_id) throw new Error('api_key and broadcast_id required');
        result = await agentGetBroadcast(args.api_key as string, args.broadcast_id as string);
        break;

      // ─── Agent Analytics ──────────────────────────────────────────
      case 'agent_analytics':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentGetAnalytics(args.api_key as string, args.period as string);
        break;

      // ─── Memory Store ──────────────────────────────────────────────
      case 'agent_memory_set':
        if (!args?.api_key || !args?.namespace || !args?.key || args?.value === undefined) throw new Error('api_key, namespace, key, value required');
        result = await agentMemorySet(args.api_key as string, args.namespace as string, args.key as string, args.value, args.value_type as string, args.ttl as number);
        break;

      case 'agent_memory_get':
        if (!args?.api_key || !args?.namespace || !args?.key) throw new Error('api_key, namespace, key required');
        result = await agentMemoryGet(args.api_key as string, args.namespace as string, args.key as string);
        break;

      case 'agent_memory_delete':
        if (!args?.api_key || !args?.namespace || !args?.key) throw new Error('api_key, namespace, key required');
        result = await agentMemoryDelete(args.api_key as string, args.namespace as string, args.key as string);
        break;

      case 'agent_memory_list':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentMemoryList(args.api_key as string, args.namespace as string, args.prefix as string);
        break;

      case 'agent_memory_namespaces':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentMemoryNamespaces(args.api_key as string);
        break;

      // ─── Data Export ───────────────────────────────────────────────
      case 'agent_export_data':
        if (!args?.api_key) throw new Error('api_key required');
        result = await agentExportData(args.api_key as string);
        break;

      // ─── Relay Federation ─────────────────────────────────────────
      case 'relay_info':
        result = await relayInfo();
        break;

      case 'relay_peers':
        result = await relayPeers();
        break;

      // ─── Heartbeat ─────────────────────────────────────────────
      case 'agent_ping':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentPing(args.api_key as string);
        break;

      case 'agent_ping_check':
        if (!args?.did) throw new Error('did is required');
        result = await agentPingCheck(args.did as string);
        break;

      // ─── Key Pinning (TOFU) ────────────────────────────────────
      case 'agent_key_pin':
        if (!args?.api_key || !args?.did) throw new Error('api_key and did are required');
        result = await agentKeyPin(args.api_key as string, args.did as string);
        break;

      case 'agent_key_pins':
        if (!args?.api_key) throw new Error('api_key is required');
        result = await agentKeyPins(args.api_key as string);
        break;

      case 'agent_key_verify':
        if (!args?.api_key || !args?.did) throw new Error('api_key and did are required');
        result = await agentKeyVerify(args.api_key as string, args.did as string);
        break;

      // ── Sentinel ─────────────────────────────────────────────────────
      case 'sentinel_current_risk':
        if (!args?.country_code) throw new Error('country_code is required');
        result = await sentinelCurrentRisk(args.country_code as string);
        break;

      case 'sentinel_global_heatmap':
        result = await sentinelGlobalHeatmap((args?.min_risk as number) || 0);
        break;

      case 'sentinel_accuracy':
        result = await sentinelAccuracy((args?.window_days as number) || 30);
        break;

      case 'sentinel_report_miss':
        if (!args?.country_code || !args?.what_happened) {
          throw new Error('country_code and what_happened are required');
        }
        result = await sentinelReportMiss(
          args.country_code as string,
          args.what_happened as string,
          args.forecast_id as string | undefined,
          args.source_url as string | undefined,
        );
        break;

      case 'sentinel_batch_risk':
        if (!Array.isArray(args?.country_codes)) {
          throw new Error('country_codes array is required');
        }
        result = await sentinelBatchRisk(args.country_codes as string[]);
        break;

      case 'sentinel_manifest':
        result = await sentinelManifest();
        break;

      case 'sentinel_calibration_history':
        result = await sentinelCalibrationHistory();
        break;

      // ── Voidly Pay ───────────────────────────────────────────────
      case 'agent_wallet_balance':
        result = await agentWalletBalance(args?.did as string | undefined);
        break;

      case 'agent_pay':
        if (!args?.to_did || typeof args.amount_credits !== 'number') {
          throw new Error('to_did and amount_credits are required');
        }
        result = await agentPay(
          args.to_did as string,
          args.amount_credits as number,
          args.memo as string | undefined,
          (args.expires_in_minutes as number | undefined) ?? 30,
        );
        break;

      case 'agent_payment_history':
        result = await agentPaymentHistory(
          args?.did as string | undefined,
          (args?.limit as number | undefined) ?? 20,
          args?.before as string | undefined,
        );
        break;

      case 'agent_pay_manifest':
        result = await agentPayManifest();
        break;

      case 'agent_escrow_open':
        if (!args?.to_did || typeof args.amount_credits !== 'number') {
          throw new Error('to_did and amount_credits are required');
        }
        result = await agentEscrowOpen(
          args.to_did as string,
          args.amount_credits as number,
          (args.deadline_hours as number | undefined) ?? 24,
          args.memo as string | undefined,
        );
        break;

      case 'agent_escrow_release':
        if (!args?.escrow_id) throw new Error('escrow_id is required');
        result = await agentEscrowRelease(args.escrow_id as string);
        break;

      case 'agent_escrow_refund':
        if (!args?.escrow_id) throw new Error('escrow_id is required');
        result = await agentEscrowRefund(args.escrow_id as string, args.reason as string | undefined);
        break;

      case 'agent_escrow_status':
        if (!args?.escrow_id) throw new Error('escrow_id is required');
        result = await agentEscrowStatus(args.escrow_id as string);
        break;

      // ─── Voidly Pay — Work receipts ────────────────────────────────
      case 'agent_work_claim':
        if (!args?.task_id || !args?.requester_did || !args?.work_hash) {
          throw new Error('task_id, requester_did, and work_hash are required');
        }
        result = await agentWorkClaim(
          args.task_id as string,
          args.requester_did as string,
          args.work_hash as string,
          args.summary as string | undefined,
          args.escrow_id as string | undefined,
          (args.acceptance_deadline_hours as number | undefined) ?? 24,
          (args.auto_accept_on_timeout as boolean | undefined) ?? true,
        );
        break;

      case 'agent_work_accept':
        if (!args?.receipt_id) throw new Error('receipt_id is required');
        result = await agentWorkAccept(
          args.receipt_id as string,
          args.rating as number | undefined,
          args.feedback as string | undefined,
        );
        break;

      case 'agent_work_dispute':
        if (!args?.receipt_id || !args?.dispute_reason) {
          throw new Error('receipt_id and dispute_reason are required');
        }
        result = await agentWorkDispute(
          args.receipt_id as string,
          args.dispute_reason as string,
          args.feedback as string | undefined,
        );
        break;

      case 'agent_receipt_status':
        if (!args?.receipt_id) throw new Error('receipt_id is required');
        result = await agentReceiptStatus(args.receipt_id as string);
        break;

      // ─── Voidly Pay — Priced capability marketplace ────────────────
      case 'agent_capability_list':
        if (!args?.capability || !args?.name || !args?.description || typeof args?.price_credits !== 'number') {
          throw new Error('capability, name, description, price_credits are required');
        }
        result = await agentCapabilityList(
          args.capability as string,
          args.name as string,
          args.description as string,
          args.price_credits as number,
          (args.unit as string | undefined) ?? 'call',
          (args.sla_deadline_hours as number | undefined) ?? 24,
          args.input_schema as string | undefined,
          args.output_schema as string | undefined,
          args.tags as string[] | undefined,
          (args.active as boolean | undefined) ?? true,
        );
        break;

      case 'agent_capability_search':
        result = await agentCapabilitySearch(
          args?.q as string | undefined,
          args?.capability as string | undefined,
          args?.max_price_credits as number | undefined,
          args?.provider_did as string | undefined,
          (args?.limit as number | undefined) ?? 50,
        );
        break;

      case 'agent_hire':
        if (!args?.capability_id) throw new Error('capability_id is required');
        result = await agentHire(
          args.capability_id as string,
          args.input as string | undefined,
          args.task_id as string | undefined,
          (args.delivery_deadline_hours as number | undefined) ?? 24,
        );
        break;

      case 'agent_hires_incoming':
        result = await agentHiresIncoming(
          args?.state as string | undefined,
          (args?.limit as number | undefined) ?? 50,
        );
        break;

      case 'agent_hires_outgoing':
        result = await agentHiresOutgoing(
          args?.state as string | undefined,
          (args?.limit as number | undefined) ?? 50,
        );
        break;

      case 'agent_faucet':
        result = await agentFaucet();
        break;

      case 'agent_trust':
        result = await agentTrust(args?.did as string | undefined);
        break;

      case 'agent_pay_stats':
        result = await agentPayStats();
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: result },
      ] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${message}` },
      ],
      isError: true };
  }
});

// Register resource handlers for direct data access
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'voidly://censorship-index',
      name: 'Global Censorship Index',
      description: 'Complete censorship index data in JSON format',
      mimeType: 'application/json' },
    {
      uri: 'voidly://methodology',
      name: 'Methodology',
      description: 'Data collection and scoring methodology',
      mimeType: 'application/json' },
  ] }));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case 'voidly://censorship-index':
      const indexData = await fetchJson(`${VOIDLY_API}/v1/censorship-index`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(indexData, null, 2) },
        ] };

    case 'voidly://methodology':
      const methodData = await fetchJson(`${VOIDLY_DATA_API}/methodology`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(methodData, null, 2) },
        ] };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// Smithery sandbox export for server scanning — returns a NEW Server instance
// that hasn't been connected to any transport yet, so Smithery can attach its own.
export function createSandboxServer() {
  const sandbox = new Server(
    { name: 'voidly', version: '2.10.0' },
    { capabilities: { tools: {}, resources: {} } }
  );
  // Copy tool listing handler to sandbox
  sandbox.setRequestHandler(ListToolsRequestSchema, async () => {
    // Return the full tool list (same handler as the main server)
    const result = await server.requestHandlers?.get?.('tools/list')?.();
    return result ?? { tools: [] };
  });
  return sandbox;
}

// Start server — only auto-connect when run as CLI (not imported by Smithery scanner)
// The scanner sets various env vars; also detect if this file was require()'d vs run directly
const isImported = typeof module !== 'undefined' && module !== require?.main;
const isSmithery = process.env.SMITHERY_SCAN || process.env.SMITHERY || process.env.SMITHERY_BUILD || isImported;

if (!isSmithery) {
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error('Voidly MCP Server running on stdio');
  }).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
