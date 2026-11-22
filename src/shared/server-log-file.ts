/**
 * Issue 707: the web server's warning lines on disk. A service starts the
 * server with --silent, so its lines reach only the in-memory log ring and
 * are gone after a restart ("hub delivery: holding …" among them). While it
 * runs silent, warn and error lines also go to <state>/logs/server.log,
 * capped by user.yml server_log.max_mb (20) and rotated once to
 * server.log.1: never more than two files. The lines are the server's own
 * log lines, which already carry no tokens; nothing else is written.
 */
import * as fs from "fs";
import * as path from "path";

/** server_log.max_mb: a Setting with a permissive default. */
export const SERVER_LOG_LIMITS = {
  max_mb: { def: 20, min: 1, max: 1024 },
} as const;

/** The levels written to the file; the rest stay in the ring. */
const LEVELS = new Set(["warn", "error"]);

/** Where the server's warning lines are kept. */
export function serverLogPath(stateDir: string): string {
  return path.join(stateDir, "logs", "server.log");
}

/** user.yml server_log.max_mb in bytes; unset or out of range: the default. */
export function serverLogMaxBytes(user: unknown): number {
  const b =
    user && typeof user === "object"
      ? (user as { server_log?: unknown }).server_log
      : undefined;
  const v =
    b && typeof b === "object" ? (b as { max_mb?: unknown }).max_mb : null;
  const { def, min, max } = SERVER_LOG_LIMITS.max_mb;
  const mb =
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
      ? v
      : def;
  return Math.floor(mb * 1024 * 1024);
}

/**
 * A writer for the server's log lines: warn and error lines are appended
 * as "<ISO time> <level> <text>". A line that would take the file past its
 * cap first moves it to server.log.1 (replacing the one there). A file it
 * can't write never stops the server.
 */
export function serverLogWriter(o: {
  stateDir: () => string;
  maxBytes: () => number;
  now?: () => Date;
}): (kind: string, text: string) => void {
  return (kind, text) => {
    if (!LEVELS.has(kind)) return;
    try {
      const file = serverLogPath(o.stateDir());
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const line = `${(o.now?.() ?? new Date()).toISOString()} ${kind} ${text}\n`;
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        /* no file yet */
      }
      if (size > 0 && size + Buffer.byteLength(line) > o.maxBytes())
        fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // The ring still has the line; the file is best effort.
    }
  };
}
