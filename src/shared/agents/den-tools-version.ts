/**
 * Issue 1223: an agent's Den tools are its MCP server, a child of its
 * session, so they keep the code of the Den the session started on. Den
 * updating restarts the web server, not the sessions. Den stamps the
 * version it starts an agent on (AgentRecord.denVersion); one started
 * before the stamp is judged by the last self-update's time
 * (server-agent/update/state.json, den-update.ts: read here as data, since
 * the CLI never imports the server).
 */
import * as fs from "fs";
import * as path from "path";
import { engineVersion } from "../paths.js";

export interface DenToolsOld {
  /** The Den its tools started on. */
  from: string;
  /** The Den installed now: a restart loads its tools. */
  to: string;
}

function lastUpdate(
  stateDir: string,
): { from?: unknown; to?: unknown; at?: unknown } | null {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(stateDir, "server-agent", "update", "state.json"),
        "utf8",
      ),
    ) as { from?: unknown; to?: unknown; at?: unknown };
  } catch {
    return null;
  }
}

/**
 * Its tools' Den against the installed one: { from, to } when older, else
 * undefined. `startedAt`: when its session started (ISO 8601).
 */
export function denToolsOld(
  rec: { denVersion?: string },
  startedAt: string | undefined,
  stateDir: string,
  /** The installed Den; null: not known (never old). */
  installed: string | null = engineVersion() ?? null,
): DenToolsOld | undefined {
  if (!installed) return undefined;
  if (rec.denVersion)
    return rec.denVersion === installed
      ? undefined
      : { from: rec.denVersion, to: installed };
  const u = lastUpdate(stateDir);
  if (
    !u ||
    u.to !== installed ||
    typeof u.from !== "string" ||
    u.from === installed ||
    typeof u.at !== "string" ||
    !startedAt
  )
    return undefined;
  const upd = Date.parse(u.at);
  const st = Date.parse(startedAt);
  return Number.isFinite(upd) && Number.isFinite(st) && upd > st
    ? { from: u.from, to: installed }
    : undefined;
}
