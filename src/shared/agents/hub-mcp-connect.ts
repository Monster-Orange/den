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
}

const FILE = "hub-mcp.json";

/** The proxy's note of an agent's MCP initialize; the latest wins. */
export function noteHubMcpInit(
  stateDir: string,
  agentId: string,
  o: { ok: boolean; error?: string },
): void {
  const dir = agentFilesDir(stateDir, agentId);
  const v: HubMcpInit = {
    ok: o.ok,
    at: new Date().toISOString(),
    ...(!o.ok && o.error ? { error: o.error.slice(0, 200) } : {}),
  };
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

/** The last note for an agent, or null. */
export function readHubMcpInit(
  stateDir: string,
  agentId: string,
): HubMcpInit | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(agentFilesDir(stateDir, agentId), FILE), "utf8"),
    ) as HubMcpInit;
    return typeof v?.ok === "boolean" && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}
