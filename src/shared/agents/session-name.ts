/**
 * An agent's session name (AG-4b): what its pane header adds after
 * `{workspace} · {runtime}`, and what its tab, the Agents list and ⌘K show.
 *
 * Two sources, and the most recent rename wins:
 *
 *   - Den's own: a person double-clicked its tab (the record's displayName,
 *     made at displayNameAt). Every runtime has it.
 *   - The runtime's, when its adapter has `sessionName` (Runtime, AG-4b):
 *     Claude Code's `/rename`. Its time is when Den first saw it, kept in
 *     the agent's files dir (session-name.json, with the conversation's
 *     token: Start fresh forgets it). An adapter that fails or throws is no
 *     name; it never breaks the list.
 *
 * D24: Den names the runtime's session for other sessions to see
 * (peerSessionName: `<cli>-<ws>:<name>`, Claude Code's `--name`) at launch
 * and resume. That name read back is Den's own (the record's peerName),
 * never a rename.
 */
import * as fs from "fs";
import * as path from "path";
import { agentFilesDir, writePrivate, type AgentRecord } from "./records.js";
import { getRuntime } from "./runtimes.js";
import { cleanName } from "./transcript-follow.js";

export {
  FOLLOW_MAX_BYTES,
  followState,
  oscTitles,
  resetFollowers,
  transcriptTitle,
} from "./transcript-follow.js";

interface Seen {
  token: string | null;
  name: string;
  /** When Den first saw it (ms). */
  at: number;
}

const seenFile = (stateDir: string, id: string) =>
  path.join(agentFilesDir(stateDir, id), "session-name.json");

function readSeen(file: string): Seen | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Seen>;
    if (typeof v.name !== "string" || typeof v.at !== "number") return null;
    return {
      token: typeof v.token === "string" ? v.token : null,
      name: v.name,
      at: v.at,
    };
  } catch {
    return null;
  }
}

/** The runtime's name for the agent's conversation, with when it was first seen. */
function runtimeName(
  rec: AgentRecord,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Seen | null {
  const rt = getRuntime(rec.runtime);
  if (!rt?.sessionName) return null;
  const token = rec.resumeToken ?? null;
  const file = seenFile(stateDir, rec.id);
  let seen = readSeen(file);
  if (seen && seen.token !== token) seen = null;
  let name: string | null = null;
  try {
    name = cleanName(rt.sessionName(rec, env));
  } catch {
    name = null;
  }
  // D24: Den's own --name, read back, is not the runtime's rename.
  if (name && name === rec.peerName) name = null;
  // null: nothing new (not caught up, not found); the last name stays.
  if (name && name !== seen?.name) {
    seen = { token, name, at: now() };
    try {
      writePrivate(file, JSON.stringify(seen) + "\n");
    } catch {
      /* shown, not kept: it is seen again next time */
    }
  }
  return seen;
}

/**
 * D24: the name other sessions (ListAgents) see agent `rec` by:
 * `<cli>-<ws>:<its name, else its id>`. No control characters: it is a
 * process argument.
 */
export function peerSessionName(
  cli: string,
  ws: string,
  rec: Pick<AgentRecord, "id" | "displayName">,
): string {
  // eslint-disable-next-line no-control-regex
  const name = (rec.displayName ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  return `${cli}-${ws}:${name.trim() || rec.id}`;
}

/**
 * The agent's session name: the latest of Den's rename and the runtime's,
 * or undefined when neither has one. Never throws.
 */
export function agentSessionName(
  rec: AgentRecord,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): string | undefined {
  let rt: Seen | null = null;
  try {
    rt = runtimeName(rec, stateDir, env, now);
  } catch {
    rt = null;
  }
  const den = rec.displayName
    ? {
        name: rec.displayName,
        at: Date.parse(rec.displayNameAt ?? rec.startedAt) || 0,
      }
    : null;
  if (den && rt) return rt.at > den.at ? rt.name : den.name;
  return (den ?? rt)?.name;
}
