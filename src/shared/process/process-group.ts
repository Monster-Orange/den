/**
 * Process groups that a detached `up` started (0.3.0-dev.37).
 *
 * A detached service is spawned as the leader of its own process group, so
 * its pid is the group id. `up` records that pgid together with the leader's
 * start time, and `down` signals the whole group: SIGTERM, a short grace
 * period, then SIGKILL.
 *
 * A recorded pid can be reused once its process exits, so nothing is
 * signalled until the group is shown to still be the one `up` started:
 *
 *  - the leader (pid == pgid) is alive: its start time must equal the
 *    recorded one, and it must still lead that group. Anything else is a
 *    different process that happens to hold the pid, and it is left alone.
 *  - the leader has exited but members still carry the pgid: the group is
 *    still ours. A process group id is not handed out again while any
 *    process is in that group, so live members of it are ones the leader
 *    started.
 *  - nothing carries the pgid: the group has exited.
 */

import { execFile, execFileSync } from "child_process";

export interface RecordedProcessGroup {
  /** The group id: the detached leader's pid. */
  pgid: number;
  /** The leader's start time as `ps -o lstart=` prints it. */
  startedAt: string;
}

export type GroupState =
  | { state: "ours"; members: number[] }
  | { state: "gone" }
  | { state: "reused"; detail: string };

export type StopGroupOutcome =
  | { outcome: "stopped"; signal: "SIGTERM" | "SIGKILL"; members: number[] }
  | { outcome: "gone" }
  | { outcome: "reused"; detail: string }
  | { outcome: "survived"; members: number[] }
  | { outcome: "error"; detail: string };

/** One `ps` row (pid, group, zombie, start time). */
export interface PsRow {
  pid: number;
  pgid: number;
  zombie: boolean;
  lstart: string;
}

const PS = "ps";
// lstart is printed in the C locale's fixed format, whatever the user's.
const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      zombie: m[3].startsWith("Z"),
      lstart: m[4].trim().replace(/\s+/g, " "),
    });
  }
  return rows;
}

const PS_COLUMNS = ["-o", "pid=,pgid=,stat=,lstart="];
const PS_ARGS = ["-A", ...PS_COLUMNS];

function psRowsSync(args: string[]): PsRow[] | null {
  try {
    return parsePs(
      execFileSync(PS, args, {
        env: PS_ENV,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }),
    );
  } catch {
    return null;
  }
}

function psRows(): Promise<PsRow[] | null> {
  return new Promise((resolve) => {
    execFile(
      PS,
      PS_ARGS,
      { env: PS_ENV, encoding: "utf-8", timeout: 5000 },
      (err, stdout) => resolve(err ? null : parsePs(stdout)),
    );
  });
}

/**
 * The record `up` keeps for a detached leader it just spawned, or null when
 * the process cannot be read (it already exited, or `ps` is unavailable).
 */
export function recordProcessGroup(pid: number): RecordedProcessGroup | null {
  const row = psRowsSync(["-p", String(pid), ...PS_COLUMNS])?.find(
    (r) => r.pid === pid && !r.zombie,
  );
  if (!row || row.pgid !== pid) return null;
  return { pgid: pid, startedAt: row.lstart };
}

/**
 * Every process's `ps` row now, read once so many records can be checked
 * against one listing (classifyGroup); null when `ps` cannot be run.
 */
export function processRows(): Promise<PsRow[] | null> {
  return psRows();
}

/** processRows, synchronously (a CLI command that is about to block anyway). */
export function processRowsSync(): PsRow[] | null {
  return psRowsSync(PS_ARGS);
}

/** A recorded group's state now, synchronously; null when `ps` cannot be run. */
export function processGroupStateSync(
  rec: RecordedProcessGroup,
): GroupState | null {
  const rows = psRowsSync(PS_ARGS);
  return rows ? classifyGroup(rec, rows) : null;
}

/** Whether a recorded group is still the one `up` started (see the header). */
export function classifyGroup(
  rec: RecordedProcessGroup,
  rows: PsRow[],
): GroupState {
  const live = rows.filter((r) => !r.zombie);
  const leader = live.find((r) => r.pid === rec.pgid);
  if (leader && (leader.lstart !== rec.startedAt || leader.pgid !== rec.pgid))
    return {
      state: "reused",
      detail: `pid ${rec.pgid} now belongs to another process (started ${leader.lstart}; the recorded one started ${rec.startedAt})`,
    };
  const members = live.filter((r) => r.pgid === rec.pgid).map((r) => r.pid);
  return members.length > 0 ? { state: "ours", members } : { state: "gone" };
}

/** The recorded group's state now; null when `ps` cannot be run. */
export async function processGroupState(
  rec: RecordedProcessGroup,
): Promise<GroupState | null> {
  const rows = await psRows();
  return rows ? classifyGroup(rec, rows) : null;
}

function signalGroup(
  pgid: number,
  signal: NodeJS.Signals,
): "sent" | "gone" | string {
  try {
    process.kill(-pgid, signal);
    return "sent";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return `${signal} to process group ${pgid} failed: ${code ?? (e as Error).message}`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntilGone(
  rec: RecordedProcessGroup,
  ms: number,
): Promise<GroupState | null> {
  const deadline = Date.now() + ms;
  let state = await processGroupState(rec);
  while (state?.state === "ours" && Date.now() < deadline) {
    await sleep(100);
    state = await processGroupState(rec);
  }
  return state;
}

/**
 * Stop a recorded process group: SIGTERM, up to `graceMs` for it to exit,
 * then SIGKILL. The group is re-verified before each signal, so a pid that
 * was reused in between is never signalled.
 */
export async function stopProcessGroup(
  rec: RecordedProcessGroup,
  graceMs = 3000,
): Promise<StopGroupOutcome> {
  const before = await processGroupState(rec);
  if (!before) return { outcome: "error", detail: "could not run ps" };
  if (before.state === "gone") return { outcome: "gone" };
  if (before.state === "reused")
    return { outcome: "reused", detail: before.detail };

  const term = signalGroup(rec.pgid, "SIGTERM");
  if (term === "gone") return { outcome: "gone" };
  if (term !== "sent") return { outcome: "error", detail: term };

  const afterTerm = await waitUntilGone(rec, graceMs);
  if (!afterTerm) return { outcome: "error", detail: "could not run ps" };
  if (afterTerm.state !== "ours")
    return { outcome: "stopped", signal: "SIGTERM", members: before.members };

  const kill = signalGroup(rec.pgid, "SIGKILL");
  if (kill !== "sent" && kill !== "gone")
    return { outcome: "error", detail: kill };
  const afterKill = await waitUntilGone(rec, 2000);
  if (afterKill?.state === "ours")
    return { outcome: "survived", members: afterKill.members };
  return { outcome: "stopped", signal: "SIGKILL", members: before.members };
}
