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
import { agentFilesDir } from "./records.js";

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
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
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

/**
 * Issue 750: whether an agent's Hub tools loaded in the run that began at
 * `startedAt`: false for a failed connect noted since then (it has no
 * hub_* tools until a restart), true for a good one, null when Den doesn't
 * know (no note, or one from an earlier run).
 */
export function hubToolsLoaded(
  init: HubMcpInit | null,
  startedAt: string | undefined,
): boolean | null {
  if (!init) return null;
  if (init.ok) return true;
  const start = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(start) && Date.parse(init.at) >= start ? false : null;
}
