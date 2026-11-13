/**
 * D56 item 8: never two writers on one conversation. Claude Code keeps a
 * record per running process, `<config>/sessions/<pid>.json` (config:
 * $CLAUDE_CONFIG_DIR, else ~/.claude), with its `pid`, the conversation it
 * has open (`sessionId`) and when the process started (`procStart`, as
 * `ps -o lstart=` prints it in UTC: "Tue Nov 10 00:56:05 2026").
 *
 * A record counts only while its process is alive AND started then: a pid
 * the system has since given to another process is not the conversation's
 * writer. Only those records are read (their names, a few fields); never a
 * transcript, never anything else there.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Claude Code's per-process records: $CLAUDE_CONFIG_DIR/sessions, else ~/.claude/sessions. */
export function claudeSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base =
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  return path.join(base, "sessions");
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * When process `pid` started, as `ps -o lstart=` prints it in UTC (the
 * form Claude Code writes), or null: no such process, or ps can't tell.
 */
export function procStartOf(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      env: { PATH: "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC" },
      timeout: 5_000,
    });
    const out = r.status === 0 ? (r.stdout ?? "").trim() : "";
    return out || null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Alive, but not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Every conversation a live process has open, by Claude Code's own
 * records: conversation id → pid (not one of `exclude`). One read of the
 * records for a whole list (D56: Bring in marks them). Never throws.
 */
export function claudeOpenPids(
  env: NodeJS.ProcessEnv = process.env,
  exclude: readonly number[] = [],
  only?: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const dir = claudeSessionsDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^(\d{1,10})\.json$/.exec(n);
    if (!m) continue;
    let rec: { pid?: unknown; sessionId?: unknown; procStart?: unknown };
    try {
      const st = fs.statSync(path.join(dir, n));
      if (!st.isFile() || st.size > 64 * 1024) continue;
      rec = JSON.parse(
        fs.readFileSync(path.join(dir, n), "utf-8"),
      ) as typeof rec;
    } catch {
      continue;
    }
    if (!rec || typeof rec.sessionId !== "string") continue;
    if (only !== undefined && rec.sessionId !== only) continue;
    if (out.has(rec.sessionId)) continue;
    const pid = typeof rec.pid === "number" ? rec.pid : Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0 || exclude.includes(pid)) continue;
    if (!alive(pid)) continue;
    // Its start time is the proof it is still that process.
    const started = procStartOf(pid);
    if (
      typeof rec.procStart !== "string" ||
      !started ||
      norm(started) !== norm(rec.procStart)
    )
      continue;
    out.set(rec.sessionId, pid);
  }
  return out;
}

/**
 * The pid of a live process (not one of `exclude`) that has conversation
 * `token` open, by Claude Code's own records; null: none. Never throws.
 */
export function claudeOpenPid(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  exclude: readonly number[] = [],
): number | null {
  return claudeOpenPids(env, exclude, token).get(token) ?? null;
}

/** The refusal's words (D56 item 8). */
export function openInMessage(pid: number): string {
  return `This conversation is open in another process (pid ${pid}). Close it first.`;
}
