/**
 * Sign-in: what lets a browser in as the person (a sign-in link or code, a
 * claim link, pairing a device, the GitHub owner) is for the person only.
 * The CLI asks here before it makes one:
 *
 *  - not inside a running session's process tree: each running session's
 *    root (the pid the session host recorded, `sessions/<id>.json`) is
 *    looked for among this process's parents, as well as the session
 *    variables (personGrantRefusal);
 *  - whole or nothing: a parent chain or a session record that can't be
 *    read refuses (fail closed);
 *  - a link or a code is printed only to a terminal (terminalRefusal).
 *
 * The server asks the same of the CLI's calls that register a link or let
 * a browser in (personCallerRefusal, in the server).
 */
import * as fs from "fs";
import * as path from "path";
import { personGrantRefusal } from "./claim-code.js";
import { parentLine } from "./peer-process.js";
import { sessionPaths } from "./sessions/paths.js";
import { agentsDir } from "./agents/records.js";
import { denProcessPids } from "./den-procs.js";

/** Where else a browser gets in: one already signed in adds the device. */
const ACCESS_HINT =
  "Already signed in in a browser? Open Settings › Access there to add another device.";

export const NOT_CHECKED = `This command can't let a browser in from here. Run it in your own terminal on this machine. ${ACCESS_HINT}`;

/** Inside a running session (an agent's, or a shell on the Terminals page). */
export const IN_A_SESSION = `This command can't let a browser in from inside an agent, or from a shell on the Terminals page. Run it in your own terminal instead. ${ACCESS_HINT}`;

/** Under Den's own server, session host or a runner. */
export const IN_DEN = `This command can't let a browser in from a process started by this install. Run it in your own terminal instead. ${ACCESS_HINT}`;

/** The server's word for a caller not on this machine's loopback. */
export const NOT_LOOPBACK = `This works only from a terminal on this machine, over localhost. On an install that listens only on its LAN address, use \`web login --no-wait\` instead. ${ACCESS_HINT}`;

export const NOT_A_TERMINAL =
  "A sign-in link is printed only in a terminal. Run it yourself in a terminal window on this machine, with its output on the screen (not sent to a file or another program).";

/**
 * The root pids of the session host's running sessions ([] when it has
 * none, or no folder yet); null when a record can't be read.
 */
export function sessionRootPids(stateDir: string): number[] | null {
  const dir = sessionPaths(stateDir).dir;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const pids: number[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    let rec: { pid?: unknown; exited?: unknown };
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")) as {
        pid?: unknown;
        exited?: unknown;
      };
    } catch (e) {
      // Gone since the listing: ended.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    if (!rec || typeof rec !== "object") return null;
    if (rec.exited === true) continue;
    if (!Number.isInteger(rec.pid) || (rec.pid as number) <= 0) return null;
    pids.push(rec.pid as number);
  }
  return pids;
}

/**
 * The session ids in the install's agent records ([] with no agents
 * folder yet); null when the folder or a record can't be read, so a
 * caller Den can't check is refused, never let through.
 */
export function agentSessionIds(stateDir: string): string[] | null {
  const dir = agentsDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const ids: string[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    const r = rec as { id?: unknown; session?: { id?: unknown } } | null;
    // Only an agent's record (its own id and a session), as listRecords.
    if (!r || typeof r !== "object" || r.id !== n.slice(0, -5)) continue;
    if (typeof r.session?.id === "string") ids.push(r.session.id);
  }
  return ids;
}

/**
 * The root pids of the running sessions among `ids` (agents' sessions;
 * a shell on the Terminals page isn't one); null when a record can't be
 * read. A session with no record, or one that ended, has none.
 */
export function agentSessionRoots(
  stateDir: string,
  ids: readonly string[],
): number[] | null {
  const dir = sessionPaths(stateDir).dir;
  const pids: number[] = [];
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    let rec: { pid?: unknown; exited?: unknown };
    try {
      rec = JSON.parse(
        fs.readFileSync(path.join(dir, `${id}.json`), "utf-8"),
      ) as { pid?: unknown; exited?: unknown };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    if (!rec || typeof rec !== "object") return null;
    if (rec.exited === true) continue;
    if (!Number.isInteger(rec.pid) || (rec.pid as number) <= 0) return null;
    pids.push(rec.pid as number);
  }
  return pids;
}

export interface PersonHereDeps {
  env?: NodeJS.ProcessEnv;
  /** The install's state dir (its session host's records). */
  stateDir: string;
  /** This process and its parents up to init; null when unreadable. */
  line?: () => number[] | null;
  /** The running sessions' root pids; null when unreadable. */
  roots?: () => number[] | null;
  /** Den's own processes' pids (den-procs.ts); null when unreadable. */
  den?: () => number[] | null;
}

/**
 * Why the CLI won't let a browser in from here, or null when it may: the
 * session variables, a running session among its parents, or a chain or
 * records it couldn't read.
 */
export function personHereRefusal(d: PersonHereDeps): string | null {
  const byEnv = personGrantRefusal(d.env ?? process.env);
  if (byEnv) return byEnv;
  const roots = (d.roots ?? (() => sessionRootPids(d.stateDir)))();
  if (!roots) return NOT_CHECKED;
  const line = (d.line ?? (() => parentLine(process.pid)))();
  if (!line || line.length === 0) return NOT_CHECKED;
  if (line.some((p) => roots.includes(p))) return IN_A_SESSION;
  const den = (d.den ?? (() => denProcessPids(d.stateDir)))();
  if (!den) return NOT_CHECKED;
  if (line.some((p) => den.includes(p))) return IN_DEN;
  return null;
}

/** Why a link or code isn't printed here: not a terminal. */
export function terminalRefusal(tty: boolean): string | null {
  return tty ? null : NOT_A_TERMINAL;
}
