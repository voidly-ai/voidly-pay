// @voidly/pay-mcp — MCP server exposing Voidly Pay tools.
//
// Use this server with Claude Code, Cursor, Windsurf, or any
// MCP-compatible client by adding to your client's config:
//
//   {
//     "mcpServers": {
//       "voidly-pay": { "command": "npx", "args": ["-y", "@voidly/pay-mcp"] }
//     }
//   }
//
// On first run the server mints + persists an Ed25519 keypair to
// ~/.voidly-pay/keypair.json (mode 0600). The DID derived from that key
// is the agent's identity for all signed envelopes.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VoidlyPay } from "@voidly/pay";
import { tools, findTool } from "./tools";

export interface ServerConfig {
  apiUrl?: string;
  secretKey?: Uint8Array;
}

export async function buildServer(config: ServerConfig = {}): Promise<{ server: Server; pay: VoidlyPay }> {
  const pay = await VoidlyPay.create({
    apiUrl: config.apiUrl,
    secretKey: config.secretKey,
  });

  const server = new Server(
    { name: "voidly-pay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: { code: "tool_not_found", message: `unknown tool: ${req.params.name}` } }) }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(pay, (req.params.arguments ?? {}) as Record<string, any>);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: { code: e?.code ?? "tool_error", message: e?.message ?? String(e), hint: e?.hint } }) }],
        isError: true,
      };
    }
  });

  return { server, pay };
}

export { tools };
