// Issue 1213: a tiny stdio MCP server for the ctx.mcp reference's test. Its
// one tool answers what it was sent, with a one-time code after it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.tool("echo", { say: z.string() }, async ({ say }) => ({
  content: [
    {
      type: "text",
      text: `${say} ABCD-EFGH (agent ${process.env.ECHO_AGENT ?? "?"})`,
    },
  ],
}));
await server.connect(new StdioServerTransport());
