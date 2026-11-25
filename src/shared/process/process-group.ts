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
import * as fs from "fs";

/**
 * Issue 639: on Linux, when the leader started in clock ticks since boot
 * (/proc/<pid>/stat field 22) and which boot that was. lstart is worked
 * out from the wall clock minus uptime, so it moves when time sync steps
 * the clock on a machine whose monotonic clock drifts; these don't.
 */
export interface LinuxStart {
  ticks: string;
  bootId: string;
}

/** The start in ticks and the boot id of `pid`, or null (not Linux, gone). */
export type ProcStartReader = (pid: number) => LinuxStart | null;

export interface RecordedProcessGroup {
  /** The group id: the detached leader's pid. */
  pgid: number;
  /** The leader's start time as `ps -o lstart=` prints it. */
  startedAt: string;
  /**
   * Issue 639: on Linux, the leader's start in ticks and the boot id; the
   * check uses these when it can read them now. Older records lack them.
   */
  linuxStart?: LinuxStart;
}

/**
 * Issue 639: field 22 (starttime) of a /proc/<pid>/stat line, or null. The
 * command name (field 2) is in parentheses and may hold spaces and
 * parentheses, so the fields are counted from its last ")".
 */
export function parseProcStatTicks(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // After ")": field 3 (state) onward; field 22 is the 20th of those.
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const v = rest[22 - 3];
  return v && /^\d+$/.test(v) ? v : null;
}

/**
 * Issue 1320: whether `pid` is running. kill(pid, 0) also succeeds for a
 * zombie (ended, not yet reaped), so on Linux its /proc state is read too
 * (the field after the name's last ")"). Where nobody reaps (a container
 * whose first process never waits) a zombie stays for good. An EPERM pid
 * is running (another user's), even with no /proc entry (hidepid). After a
 * kill(0) that succeeded, a stat gone (ENOENT) means it ended; any other
 * unreadable stat leaves kill's answer.
 */
export function pidRunning(
  pid: number,
  o: {
    platform?: NodeJS.Platform;
    readStat?: (pid: number) => string;
    kill?: (pid: number, signal: 0) => void;
  } = {},
): boolean {
  let eperm = false;
  try {
    (o.kill ?? ((p, sig) => process.kill(p, sig)))(pid, 0);
  } catch (e) {
    if ((e as { code?: string }).code !== "EPERM") return false;
    eperm = true;
  }
  if ((o.platform ?? process.platform) !== "linux") return true;
  let line: string;
  try {
    line = (o.readStat ?? ((p) => fs.readFileSync(`/proc/${p}/stat`, "utf-8")))(
      pid,
    );
  } catch (e) {
    // Under hidepid, another user's live process has no /proc entry.
    return eperm || (e as { code?: string }).code !== "ENOENT";
  }
  const close = line.lastIndexOf(")");
  return close < 0 || line.slice(close + 1).trim()[0] !== "Z";
}

/** Issue 639: /proc's start in ticks and boot id; null off Linux or gone. */
export function linuxStartOf(pid: number): LinuxStart | null {
  if (process.platform !== "linux") return null;
  try {
    const ticks = parseProcStatTicks(
      fs.readFileSync(`/proc/${pid}/stat`, "utf-8"),
    );
    const bootId = fs
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf-8")
      .trim();
    return ticks && bootId ? { ticks, bootId } : null;
  } catch {
    return null;
  }
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

interface PsRow {
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
export function recordProcessGroup(
  pid: number,
  start: ProcStartReader = linuxStartOf,
): RecordedProcessGroup | null {
  const row = psRowsSync(["-p", String(pid), ...PS_COLUMNS])?.find(
    (r) => r.pid === pid && !r.zombie,
  );
  if (!row || row.pgid !== pid) return null;
  const linuxStart = start(pid);
  return {
    pgid: pid,
    startedAt: row.lstart,
    ...(linuxStart ? { linuxStart } : {}),
  };
}

/** A recorded group's state now, synchronously; null when `ps` cannot be run. */
export function processGroupStateSync(
  rec: RecordedProcessGroup,
  start: ProcStartReader = linuxStartOf,
): GroupState | null {
  const rows = psRowsSync(PS_ARGS);
  return rows ? classifyGroup(rec, rows, start) : null;
}

/** Whether a recorded group is still the one `up` started (see the header). */
export function classifyGroup(
  rec: RecordedProcessGroup,
  rows: PsRow[],
  start: ProcStartReader = linuxStartOf,
): GroupState {
  const live = rows.filter((r) => !r.zombie);
  const leader = live.find((r) => r.pid === rec.pgid);
  if (leader) {
    const reused = (detail: string): GroupState => ({
      state: "reused",
      detail: `pid ${rec.pgid} now belongs to another process (${detail})`,
    });
    if (leader.pgid !== rec.pgid)
      return reused(`it leads process group ${leader.pgid}`);
    // Issue 639: the start in ticks and the boot id when both are known;
    // a moving lstart then doesn't count. Else lstart, as before.
    const now = rec.linuxStart ? start(rec.pgid) : null;
    if (rec.linuxStart && now) {
      if (now.bootId !== rec.linuxStart.bootId)
        return reused("the machine has restarted since it was recorded");
      if (now.ticks !== rec.linuxStart.ticks)
        return reused(
          `started at tick ${now.ticks}; the recorded one at ${rec.linuxStart.ticks}`,
        );
    } else if (leader.lstart !== rec.startedAt)
      return reused(
        `started ${leader.lstart}; the recorded one started ${rec.startedAt}`,
      );
  }
  const members = live.filter((r) => r.pgid === rec.pgid).map((r) => r.pid);
  return members.length > 0 ? { state: "ours", members } : { state: "gone" };
}

/** The recorded group's state now; null when `ps` cannot be run. */
export async function processGroupState(
  rec: RecordedProcessGroup,
  start: ProcStartReader = linuxStartOf,
): Promise<GroupState | null> {
  const rows = await psRows();
  return rows ? classifyGroup(rec, rows, start) : null;
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
