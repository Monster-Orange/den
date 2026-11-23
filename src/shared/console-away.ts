/**
 * Issue 163: when the person was logged out, and which agents ran then.
 *
 * Under Keep agents running after logout (mode always) the web server is
 * a LaunchDaemon: a logout never stops it, so the restart note ("ran while
 * Den was away") never fires for a logout and login. The web server
 * watches who owns the console instead: /dev/console belongs to the
 * logged-in person, to root at the login window, and to another uid after
 * a user switch. No subprocess, no launchctl: one stat.
 *
 * When the person leaves, the time and the running agents are kept in
 * CONSOLE_AWAY_FILE in the state dir (so a web server restart while away
 * loses nothing); when they come back, stepConsole says who kept running,
 * who started and who ended, and forgets it.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";

export const CONSOLE_AWAY_FILE = "console-away.json";

/** The console owner's uid on macOS; null elsewhere or when unreadable. */
export function consoleOwnerUid(
  platform: NodeJS.Platform = process.platform,
  stat: (p: string) => { uid: number } = (p) => fs.statSync(p),
): number | null {
  if (platform !== "darwin") return null;
  try {
    const uid = stat("/dev/console").uid;
    return Number.isInteger(uid) ? uid : null;
  } catch {
    return null;
  }
}

export interface ConsoleBack {
  /** How long the person was away. */
  awayMs: number;
  /** Running when they left and still running. */
  kept: string[];
  /** Started while they were away, running now. */
  started: string[];
  /** Running when they left, not now. */
  ended: string[];
}

interface AwayRecord {
  awayAt: number;
  running: string[];
}

function readAway(file: string): AwayRecord | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8")) as AwayRecord;
    if (typeof j.awayAt !== "number" || !Array.isArray(j.running)) return null;
    return { awayAt: j.awayAt, running: j.running.map(String) };
  } catch {
    return null;
  }
}

/**
 * One look at the console. `left`: the person just left (recorded).
 * `back`: they just came back (the record is forgotten).
 */
export function stepConsole(
  stateDir: string,
  d: { me: number; owner: number | null; running: string[]; now: number },
): { left: boolean; back: ConsoleBack | null } {
  const none = { left: false, back: null };
  if (d.owner === null) return none;
  const file = path.join(stateDir, CONSOLE_AWAY_FILE);
  const away = fs.existsSync(file) ? readAway(file) : null;
  if (d.owner !== d.me) {
    if (away) return none;
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(
        file,
        JSON.stringify({ awayAt: d.now, running: d.running }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      return none;
    }
    return { left: true, back: null };
  }
  if (!fs.existsSync(file)) return none;
  fs.rmSync(file, { force: true });
  if (!away) return none;
  const before = new Set(away.running);
  const now = new Set(d.running);
  return {
    left: false,
    back: {
      awayMs: Math.max(0, d.now - away.awayAt),
      kept: d.running.filter((a) => before.has(a)),
      started: d.running.filter((a) => !before.has(a)),
      ended: away.running.filter((a) => !now.has(a)),
    },
  };
}
