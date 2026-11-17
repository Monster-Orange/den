/**
 * Issue 335: a project's extra HTTP MCP servers, for its agents only.
 *
 *   # config/local/workspaces.yml
 *   workspaces:
 *     north:
 *       agents:
 *         mcp_servers:
 *           - name: tracker                    # its name in the MCP config
 *             url: https://mcp.tracker.example  # Streamable HTTP
 *             bearer: tracker_token             # optional: a secrets.refs name
 *
 * Den adds each one to the --mcp-config it writes for that project's
 * agents, as Hub's entry is (runtime.ts): an HTTP entry whose headersHelper
 * runs `<cli> mcp headers <name>` at each connect. That command proves the
 * caller with the agent's own token (its file), takes the project from
 * what the token was minted for (never from an argument), and reads the
 * bearer from the install's secrets store then. The bearer is never in
 * the MCP file, the agent's env, a record, a page or a log: Settings and
 * doctor show a server's name and url only.
 */
import { actorTokenOf, verifyActorToken } from "../actor-token.js";
import { shellQuote } from "../cli-command.js";
import { redactSecrets } from "../redact.js";

export interface ProjectMcpServer {
  name: string;
  url: string;
  /** The name of a secrets.refs entry; never a value. */
  bearer?: string;
}

/** A server's name: what the agent's tools are called by (mcp__<name>__…). */
export const PROJECT_MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A secrets.refs entry's name. */
export const SECRET_REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** A URL Den sends a bearer to: https, or http to this machine. */
export function projectMcpUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    return `must be https (http only to this machine): ${url}`;
  if (u.username || u.password)
    return "must not carry a name or password (use bearer)";
  return null;
}

/**
 * One entry checked: the server, or why it is refused (naming its key).
 * `taken`: names it may not use (Den's own server, Hub's).
 */
export function checkProjectMcpServer(
  raw: unknown,
  taken: readonly string[] = [],
): { ok: true; server: ProjectMcpServer } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "each entry is { name, url, bearer? }" };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!PROJECT_MCP_NAME_RE.test(name))
    return {
      ok: false,
      error:
        "name: lower-case letters, digits, - and _, up to 40, starting with a letter or digit",
    };
  if (taken.includes(name))
    return { ok: false, error: `name: "${name}" is taken by Den's own MCP` };
  const url = typeof r.url === "string" ? r.url.trim().replace(/\/+$/, "") : "";
  const bad = projectMcpUrlProblem(url);
  if (bad) return { ok: false, error: `url ${bad}` };
  const b = r.bearer;
  if (b === undefined || b === null || b === "")
    return { ok: true, server: { name, url } };
  if (typeof b !== "string" || !SECRET_REF_NAME_RE.test(b.trim()))
    return {
      ok: false,
      error:
        "bearer: the name of a secrets.refs entry (letters, digits, . - _), never a value",
    };
  return { ok: true, server: { name, url, bearer: b.trim() } };
}

/**
 * A project's `agents.mcp_servers`, checked: the good ones, and a line for
 * each one refused (no value in it). A repeated name keeps the first.
 */
export function parseProjectMcpServers(
  raw: unknown,
  taken: readonly string[] = [],
): { servers: ProjectMcpServer[]; problems: string[] } {
  const servers: ProjectMcpServer[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { servers, problems };
  if (!Array.isArray(raw))
    return { servers, problems: ["agents.mcp_servers must be a list"] };
  raw.forEach((e, i) => {
    const c = checkProjectMcpServer(e, taken);
    if (!c.ok) problems.push(`agents.mcp_servers[${i}]: ${c.error}`);
    else if (servers.some((s) => s.name === c.server.name))
      problems.push(
        `agents.mcp_servers[${i}]: "${c.server.name}" is listed twice`,
      );
    else servers.push(c.server);
  });
  return { servers, problems };
}

/**
 * The headersHelper for server `name`: `<cli> mcp headers <name>`, with
 * the distribution's location (paths, never a secret) for that command
 * only. The agent's env is an allowlist; this keeps it so.
 */
export function projectMcpHeadersHelper(
  bin: readonly string[],
  env: Record<string, string>,
  name: string,
): string {
  const assign = Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...assign, ...bin.map(shellQuote), "mcp", "headers", shellQuote(name)]
    .join(" ")
    .trim();
}

export interface McpHeadersDeps {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** Project `ws`'s servers (checked). */
  servers: (ws: string) => ProjectMcpServer[];
  /** The value of secrets.refs entry `ref`, from the install's store. */
  secret: (ref: string) => Promise<string>;
}

/**
 * `<cli> mcp headers <name>`: the headers JSON for the calling agent's
 * project's server `name`, or why not. The project is the one the agent's
 * token was minted for. An error never holds the bearer.
 */
export async function projectMcpHeaders(
  name: string,
  d: McpHeadersDeps,
): Promise<{ ok: true; json: string } | { ok: false; error: string }> {
  const token = actorTokenOf(d.env);
  if (!token) return { ok: false, error: "no agent token: not an agent" };
  const rec = verifyActorToken(d.stateDir, token);
  if (!rec)
    return {
      ok: false,
      error: "the agent's token isn't live: restart or resume the agent",
    };
  const ws = rec.workspace;
  const server = d.servers(ws).find((s) => s.name === name);
  if (!server)
    return { ok: false, error: `project ${ws} has no MCP server "${name}"` };
  if (!server.bearer) return { ok: true, json: "{}" };
  let value: string;
  try {
    value = (await d.secret(server.bearer)).trim();
  } catch (e) {
    // A store's own words, secret-shaped values scrubbed (redact.ts).
    const why = redactSecrets(String((e as Error)?.message ?? e));
    return {
      ok: false,
      error: `secrets.refs.${server.bearer} can't be read: ${why.slice(0, 200)}`,
    };
  }
  if (!value)
    return { ok: false, error: `secrets.refs.${server.bearer} is empty` };
  return {
    ok: true,
    json: JSON.stringify({ Authorization: `Bearer ${value}` }),
  };
}
