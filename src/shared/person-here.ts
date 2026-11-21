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
import { AGENT_REFUSAL, personGrantRefusal } from "./claim-code.js";
import { parentLine } from "./peer-process.js";
import { sessionPaths } from "./sessions/paths.js";

export const NOT_CHECKED =
  "It couldn't check where this command runs (its parent processes or the running sessions), so it won't let a browser in from here. Run it in your own terminal.";

export const NOT_A_TERMINAL =
  "A sign-in link is printed only in a terminal. Run it in your own terminal, with its output on the screen.";

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

export interface PersonHereDeps {
  env?: NodeJS.ProcessEnv;
  /** The install's state dir (its session host's records). */
  stateDir: string;
  /** This process and its parents up to init; null when unreadable. */
  line?: () => number[] | null;
  /** The running sessions' root pids; null when unreadable. */
  roots?: () => number[] | null;
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
  if (line.some((p) => roots.includes(p))) return AGENT_REFUSAL;
  return null;
}

/** Why a link or code isn't printed here: not a terminal. */
export function terminalRefusal(tty: boolean): string | null {
  return tty ? null : NOT_A_TERMINAL;
}
