/**
 * What an agent's Hub MCP connection actually got. Den's /hub proxy notes
 * each MCP initialize (a POST to /mcp with no Mcp-Session-Id) in the
 * agent's own files: ok, or the error ("hub (502): Bad Gateway"). A
 * runtime whose connect failed has no hub_* tools until it connects again
 * (a restart), so whoami reports what it got, not what its config said.
 * Never a token or a body: only whether it worked, and the status line.
 */
import * as fs from "fs";
import * as path from "path";
import { HUB_SERVER } from "../hub.js";
import { agentFilesDir } from "./records.js";
import { writeFileAtomic } from "../atomic-write.js";

export interface HubMcpInit {
  ok: boolean;
  /** When the connect was answered (ISO). */
  at: string;
  /** For a failed one: what Den saw, one line. */
  error?: string;
  /**
   * 0.4.48: the agent's latest Hub call through Den (any, not only the
   * connect), so the file says how its calls go now.
   */
  last?: HubMcpCall;
  /**
   * Issue 749: false when the connect worked but listing Hub's tools
   * failed (tools/list), so the session has no hub_* tools either; true
   * once a listing worked (Den's one restart for it is spent until then).
   */
  tools?: boolean;
}

export interface HubMcpCall {
  ok: boolean;
  at: string;
  error?: string;
}

const FILE = "hub-mcp.json";

/** The proxy's note of an agent's MCP initialize; the latest wins. */
export function noteHubMcpInit(
  stateDir: string,
  agentId: string,
  o: { ok: boolean; error?: string },
): void {
  const last = readRaw(stateDir, agentId)?.last;
  write(stateDir, agentId, {
    ...note(o),
    ...(last ? { last } : {}),
  });
}

/**
 * 0.4.48: the proxy's note of an agent's Hub call (each one): kept as
 * `last` beside the connect's note, which is what whoami's "loaded" reads.
 */
export function noteHubMcpCall(
  stateDir: string,
  agentId: string,
  o: { ok: boolean; error?: string },
): void {
  // No connect noted yet: only the call (never read as a connect).
  write(stateDir, agentId, { ...readRaw(stateDir, agentId), last: note(o) });
}

/**
 * Issue 749: the proxy's note of an agent's tools/list. A connect that
 * worked is no use when its tool listing failed: the runtime runs on with
 * none of Hub's tools, so the note reads as a failed connect (whoami says
 * not loaded, restart; Den's reconnect restarts it once Hub answers). A
 * listing that worked clears only a failure of its own kind.
 */
export function noteHubMcpTools(
  stateDir: string,
  agentId: string,
  o: { ok: boolean; error?: string },
): void {
  const had = readRaw(stateDir, agentId);
  const last = had?.last;
  if (!o.ok) {
    write(stateDir, agentId, {
      ...note({
        ok: false,
        error: `listing Hub's tools failed (${o.error ?? "an error"})`,
      }),
      tools: false,
      ...(last ? { last } : {}),
    });
    return;
  }
  if (had?.tools === false)
    write(stateDir, agentId, {
      ...note({ ok: true }),
      tools: true,
      ...(last ? { last } : {}),
    });
  else if (had && typeof had.ok === "boolean" && had.tools !== true)
    write(stateDir, agentId, { ...had, tools: true });
}

/** Issue 749: whether its latest connect has had a tool listing that worked. */
export function hubToolsListed(stateDir: string, agentId: string): boolean {
  return readHubMcpInit(stateDir, agentId)?.tools === true;
}

/** Issue 749: an MCP server whose tools this agent's session didn't get. */
export interface McpLoadFailure {
  server: string;
  error: string;
  at: string;
}

/**
 * Issue 749: the MCP servers whose tools failed to load in the agent's
 * current session (a note from before it started doesn't count). Hub's
 * only, for now: Den sees Hub's calls through its proxy and no others.
 */
export function mcpLoadFailures(
  stateDir: string,
  rec: { id: string; startedAt: string },
): McpLoadFailure[] {
  const init = readHubMcpInit(stateDir, rec.id);
  if (!init || init.ok || Date.parse(init.at) < Date.parse(rec.startedAt))
    return [];
  return [{ server: HUB_SERVER, error: init.error ?? "an error", at: init.at }];
}

function note(o: { ok: boolean; error?: string }): HubMcpCall {
  return {
    ok: o.ok,
    at: new Date().toISOString(),
    ...(!o.ok && o.error ? { error: o.error.slice(0, 200) } : {}),
  };
}

function write(
  stateDir: string,
  agentId: string,
  v: Partial<HubMcpInit>,
): void {
  const dir = agentFilesDir(stateDir, agentId);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, FILE);
    writeFileAtomic(file, JSON.stringify(v) + "\n", { mode: 0o600 });
  } catch {
    // A note that can't be written never stops the agent's call.
  }
}

/** The file as it is, or null. */
function readRaw(
  stateDir: string,
  agentId: string,
): Partial<HubMcpInit> | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(
        path.join(agentFilesDir(stateDir, agentId), FILE),
        "utf8",
      ),
    ) as Partial<HubMcpInit> | null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** The last connect's note for an agent (with its latest call), or null. */
export function readHubMcpInit(
  stateDir: string,
  agentId: string,
): HubMcpInit | null {
  const v = readRaw(stateDir, agentId);
  return v && typeof v.ok === "boolean" && typeof v.at === "string"
    ? (v as HubMcpInit)
    : null;
}
