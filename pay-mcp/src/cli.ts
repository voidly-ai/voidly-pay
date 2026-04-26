// CLI entry point for the @voidly/pay-mcp server. Wires up stdio transport
// and starts the server. Pass --api-url to override the default endpoint.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./index";

async function main() {
  const args = process.argv.slice(2);
  const apiUrlIdx = args.indexOf("--api-url");
  const apiUrl = apiUrlIdx >= 0 ? args[apiUrlIdx + 1] : process.env.VOIDLY_PAY_API_URL;

  const { server, pay } = await buildServer({ apiUrl });
  // Tell the operator (via stderr — stdout is the MCP protocol channel) what
  // DID this server is acting as, so they can fund it via the faucet.
  process.stderr.write(`[voidly-pay-mcp] DID: ${pay.did}\n`);
  process.stderr.write(`[voidly-pay-mcp] API: ${(apiUrl || "https://api.voidly.ai")}\n`);
  process.stderr.write(`[voidly-pay-mcp] Public key (b64): ${pay.publicKey()}\n`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`[voidly-pay-mcp] fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
