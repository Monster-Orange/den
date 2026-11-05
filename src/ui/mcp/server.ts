/**
 * `<cli> mcp`: an MCP server over stdio, a thin client of the running web
 * server (http://localhost:<web.port>). Agents and the web UI share one
 * state and one set of guards; nothing is started implicitly.
 *
 * stdout carries the protocol only: diagnostics go to stderr.
 */
import { z } from "zod";
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
import { ownServer } from "../cli/server-identity.js";
import { callTool, toolsFor, type ToolContext } from "./tools.js";
import { plural } from "../../shared/plural.js";

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
      // Serve nothing from another distribution's server on the port.
      identity: { own: ownServer() },
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
    `       ${cli} mcp --list`,
    `       ${cli} mcp --call <tool> ['<json args>']`,
    "",
    `An MCP server over stdio for agents, a client of the running web server`,
    `(\`${cli} web up\`; default port: config web.port). Read tools always;`,
    "actions only as named in the org config's mcp.actions. See docs/distributions.md.",
    "",
    "--list prints the tool names; --call runs one tool through the same guards,",
    "prints its text result and exits 1 if the tool reports an error.",
    "",
    `Register it with your agents: ${cli} mcp clients, then ${cli} mcp connect <client> (or --all).`,
  ].join("\n");

/** A one-shot invocation: `--list`, or `--call <tool> [json]`. */
export type OneShot =
  | { kind: "list" }
  | { kind: "call"; tool: string; args: Record<string, unknown> };

/** The one-shot `argv` asks for, or null for the stdio server. */
export function parseOneShot(argv: string[]): OneShot | null {
  const i = argv.indexOf("--call");
  if (i !== -1) {
    const tool = argv[i + 1];
    if (!tool || tool.startsWith("-"))
      throw new Error("--call needs a tool name: --call <tool> ['<json>']");
    const raw = argv[i + 2];
    if (raw === undefined || raw.startsWith("--"))
      return { kind: "call", tool, args: {} };
    let args: unknown;
    try {
      args = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `--call ${tool}: arguments are not JSON (${(e as Error).message})`,
      );
    }
    if (args === null || typeof args !== "object" || Array.isArray(args))
      throw new Error(`--call ${tool}: arguments must be a JSON object`);
    return { kind: "call", tool, args: args as Record<string, unknown> };
  }
  return argv.includes("--list") ? { kind: "list" } : null;
}

export interface OneShotOptions {
  cfg: ResolvedMcpConfig;
  cli: string;
  api: DenApi;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/**
 * Run a one-shot through the tool layer the stdio server uses (callTool:
 * mcp.actions, every guard, redaction). Returns the exit code.
 */
export async function runOneShot(
  shot: OneShot,
  opts: OneShotOptions,
): Promise<number> {
  const out = opts.out ?? ((t: string) => process.stdout.write(t));
  if (shot.kind === "list") {
    const names = toolsFor(opts.cfg).map((t) => t.name);
    out(names.length ? `${names.join("\n")}\n` : "");
    return 0;
  }
  const ctx: ToolContext = { api: opts.api, cfg: opts.cfg, cli: opts.cli };
  // The stdio server validates arguments against each tool's schema (the
  // SDK does it); a one-shot must too, and strictly: it is typed by hand, so
  // an unknown or misspelt key is an error, not silently dropped.
  let args = shot.args;
  const tool = toolsFor(opts.cfg).find((t) => t.name === shot.tool);
  if (tool) {
    const parsed = z.object(tool.shape).strict().safeParse(args);
    if (!parsed.success) {
      const err = opts.err ?? ((t: string) => process.stderr.write(t));
      const lines = parsed.error.issues.map((i) => {
        const at = i.path.length ? i.path.join(".") : "(arguments)";
        return `  ${at}: ${i.message}`;
      });
      const keys = Object.keys(tool.shape);
      err(
        `--call ${shot.tool}: invalid arguments\n${lines.join("\n")}\n` +
          `  takes: ${keys.length ? keys.join(", ") : "no arguments"}\n`,
      );
      return 2;
    }
    args = parsed.data as Record<string, unknown>;
  }
  const r = await callTool(shot.tool, args, ctx);
  out(r.text.endsWith("\n") ? r.text : `${r.text}\n`);
  return r.isError ? 1 : 0;
}

/** Run `<cli> mcp` until stdin closes (or one `--call` / `--list`). */
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
  const shot = parseOneShot(argv);
  if (shot) {
    // Recorded like any MCP action: actor agent, this process, one session.
    const session = randomUUID();
    const api = createDenApi({
      baseUrl,
      cli,
      identity: { own: ownServer() },
      headers: () =>
        agentAuditHeaders({
          client: `${cli} mcp --call`,
          clientVersion: engineVersion() ?? "unknown",
          mcpPid: process.pid,
          session,
        }),
    });
    process.exitCode = await runOneShot(shot, { cfg, cli, api });
    return;
  }
  const server = createDenMcpServer({ cfg, baseUrl, cli });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${cli} mcp: ${plural(toolsFor(cfg).length, "tool")} ` +
      `(${cfg.actions.length ? `actions: ${cfg.actions.join(", ")}` : "read only"}) → ${baseUrl}\n`,
  );
}
