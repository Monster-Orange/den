/**
 * `<cli> mcp`: an MCP server over stdio, a thin client of the running web
 * server (http://localhost:<web.port>). Agents and the web UI share one
 * state and one set of guards; nothing is started implicitly.
 *
 * stdout carries the protocol only: diagnostics go to stderr.
 */
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentAuditHeaders } from "../../shared/agent-actor.js";
import {
  readMcpConfig,
  type ResolvedMcpConfig,
} from "../../shared/den-config.js";
import { readWebPort } from "../../shared/edge/config.js";
import { engineVersion } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { createDenApi, type DenApi } from "./api.js";
import { callTool, toolsFor, type ToolContext } from "./tools.js";

export interface DenMcpOptions {
  cfg: ResolvedMcpConfig;
  baseUrl: string;
  cli: string;
  /** One id per MCP server process, recorded with every action. */
  session?: string;
  pid?: number;
  /** For tests: an API in place of the HTTP client. */
  api?: DenApi;
  log?: (line: string) => void;
}

export function createDenMcpServer(opts: DenMcpOptions): McpServer {
  const p = product();
  const session = opts.session ?? randomUUID();
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const tools = toolsFor(opts.cfg);
  const server = new McpServer(
    { name: p.name, version: engineVersion() ?? "0.0.0" },
    {
      instructions:
        `${p.title}: local services, workspaces, logs and tests for this org, ` +
        `through the running ${p.title} web server (\`${opts.cli} web up\`). ` +
        (opts.cfg.actions.length
          ? `Actions enabled: ${opts.cfg.actions.join(", ")}.`
          : "Read-only: the org has enabled no actions (mcp.actions)."),
    },
  );

  // The client's self-reported name/version, known once it has initialized.
  const client = () => server.server.getClientVersion();
  const api =
    opts.api ??
    createDenApi({
      baseUrl: opts.baseUrl,
      cli: opts.cli,
      headers: () =>
        agentAuditHeaders({
          client: client()?.name ?? "unknown",
          clientVersion: client()?.version ?? "unknown",
          mcpPid: opts.pid ?? process.pid,
          session,
        }),
    });
  const ctx: ToolContext = { api, cfg: opts.cfg, cli: opts.cli };

  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.shape,
        annotations: {
          readOnlyHint: !t.action,
          destructiveHint: t.action,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const r = await callTool(t.name, args ?? {}, ctx);
        if (t.action || r.isError) {
          const who = client();
          log(
            `[mcp] ${t.name} ${r.isError ? "refused/failed" : "ok"} · ` +
              `${who?.name ?? "unknown"} ${who?.version ?? ""} · session ${session}` +
              (r.isError ? ` · ${r.text.split("\n")[0]}` : ""),
          );
        }
        return {
          content: [{ type: "text" as const, text: r.text }],
          isError: r.isError,
        };
      },
    );
  }
  return server;
}

function parsePort(argv: string[]): number | undefined {
  const i = argv.indexOf("--port");
  const raw =
    i !== -1
      ? argv[i + 1]
      : argv.find((a) => a.startsWith("--port="))?.slice(7);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`--port must be a port number, got "${raw}"`);
  return n;
}

export const MCP_USAGE = (cli: string): string =>
  [
    `Usage: ${cli} mcp [--port <web port>]`,
    "",
    `An MCP server over stdio for agents, a client of the running web server`,
    `(\`${cli} web up\`; default port: config web.port). Read tools always;`,
    "actions only as named in the org config's mcp.actions. See docs/distributions.md.",
    "",
    `Register it with your agents: ${cli} mcp clients, then ${cli} mcp connect <client> (or --all).`,
  ].join("\n");

/** Run `<cli> mcp` until stdin closes. */
export async function runMcp(argv: string[]): Promise<void> {
  const cli = product().cli;
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write(`${MCP_USAGE(cli)}\n`);
    return;
  }
  let port = parsePort(argv);
  if (port === undefined) {
    try {
      port = readWebPort();
    } catch {
      port = DEFAULT_PORT;
    }
  }
  const cfg = readMcpConfig();
  const baseUrl = `http://localhost:${port}`;
  const server = createDenMcpServer({ cfg, baseUrl, cli });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${cli} mcp: ${toolsFor(cfg).length} tools ` +
      `(${cfg.actions.length ? `actions: ${cfg.actions.join(", ")}` : "read only"}) → ${baseUrl}\n`,
  );
}
