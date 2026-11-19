/**
 * Issue 500: a terminal host that doesn't answer.
 *
 * The host (host.ts) can wedge: it holds its socket, so nothing starts a
 * new one, and it answers nothing, so no shell starts. Every hello and
 * start now waits at most Settings › Terminal host wait (client.ts)
 * and fails "timeout"; doctor and Terminal say so. The host writes what it
 * runs to sessions.host.json as it begins to serve, so one that stopped
 * answering can still be named (its pid, version, start).
 *
 * Restarting it is a person's act (Terminal's Restart, through the working
 * pop-up, or `<cli> sessions host --stop`): a host that answers is asked to
 * stop, the supported way; one that doesn't is sent SIGTERM, then SIGKILL,
 * but only when sessions.host.json names a live process that is a Den
 * terminal host started no later than it says (never a reused pid, never
 * this process). The service manager, or Den on demand, starts a new one.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import { HostError, noHost, type HostClient } from "./client.js";
import { stopHost } from "./host-refresh.js";

/** What a host wrote to sessions.host.json. */
export interface HostInfo {
  pid: number;
  startedAt: string;
  /** The Den version it runs (null: it couldn't tell). */
  den: string | null;
  code: string | null;
}

/** sessions.host.json, or null when there is none or it can't be read. */
export function readHostInfo(file: string): HostInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    if (!Number.isInteger(v.pid) || (v.pid as number) <= 0) return null;
    return {
      pid: v.pid as number,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
      den: typeof v.den === "string" ? v.den : null,
      code: typeof v.code === "string" ? v.code : null,
    };
  } catch {
    return null;
  }
}

/** Whether `e` (from a connect) means the host is there but doesn't answer. */
export function hostStuck(e: unknown): boolean {
  return e instanceof HostError && e.code === "timeout";
}

/** "pid 123, version 0.4.73, started …" for a host's info (or less). */
export function describeHost(info: HostInfo | null): string {
  if (!info) return "its version isn't known (it wrote no sessions.host.json)";
  return (
    `pid ${info.pid}, version ${info.den ?? "unknown"}` +
    (info.startedAt ? `, started ${info.startedAt}` : "")
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether process `pid` is the host `info` describes: alive, its command
 * line runs `sessions` (a Den terminal host), and it started no later than
 * the host says it did (a pid reused since started after). ps, read only.
 */
export function isHostProcess(info: HostInfo): boolean {
  if (info.pid === process.pid || !pidAlive(info.pid)) return false;
  const ps = (field: string): string => {
    const r = spawnSync("ps", ["-o", `${field}=`, "-p", String(info.pid)], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return r.status === 0 ? String(r.stdout ?? "").trim() : "";
  };
  if (!/\bsessions\b|sessions-host/.test(ps("command"))) return false;
  const began = Date.parse(ps("lstart"));
  const says = Date.parse(info.startedAt);
  // ps gives whole seconds; the host's own start comes after its process's.
  return Number.isFinite(began) && Number.isFinite(says)
    ? began <= says + 2000
    : false;
}

export interface StopHostDeps {
  socket: string;
  /** sessions.host.json. */
  infoFile: string;
  /** The host if one answers, null when none runs; throws "timeout" when stuck. */
  connectExisting(): Promise<HostClient | null>;
  /** How long a stuck host gets to end after SIGTERM, then SIGKILL (ms). */
  termWaitMs?: number;
  /** Seams for a test; the defaults above. */
  isHost?: (info: HostInfo) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
}

export interface RestartHostDeps extends StopHostDeps {
  /** The host, started when none answers. */
  connect(): Promise<HostClient>;
}

export interface HostStopped {
  /** The host that ended (0: none ran). */
  from: number;
  /** It didn't answer, so it was sent a signal. */
  forced: boolean;
  /** Sessions that ended with it (null: a stuck host can't say). */
  ended: number | null;
  /** What the old host ran (null: unknown). */
  fromVersion: string | null;
}

export interface HostRestarted extends HostStopped {
  to: number;
}

/**
 * Stop the terminal host (a person's act): the supported way when it
 * answers, by signal when it doesn't. Throws (with the reason) when it
 * can't. Its sessions end.
 */
export async function stopAnyHost(d: StopHostDeps): Promise<HostStopped> {
  const info = readHostInfo(d.infoFile);
  let c: HostClient | null = null;
  let stuck: Error | null = null;
  try {
    c = await d.connectExisting();
  } catch (e) {
    if (!hostStuck(e) && !noHost(e)) throw e;
    if (hostStuck(e)) stuck = e as Error;
  }
  let from = 0;
  let ended: number | null = 0;
  let fromVersion: string | null = info?.den ?? null;
  if (c) {
    fromVersion = c.hostDen ?? fromVersion;
    try {
      const r = await stopHost(c, d.socket);
      from = r.pid;
      ended = r.ended;
    } catch (e) {
      // It answered hello, then not the stop: it is stuck after all.
      c.close();
      if (!hostStuck(e)) throw e;
      stuck = e as Error;
    }
  }
  if (stuck) {
    if (!info)
      throw new Error(
        `the terminal host doesn't answer (${stuck.message}), and it wrote no sessions.host.json, so Den can't tell which process it is; restart Den's terminal host service`,
      );
    if (!(d.isHost ?? isHostProcess)(info))
      throw new Error(
        `the terminal host doesn't answer (${stuck.message}), and pid ${info.pid} from sessions.host.json is not that host any more; restart Den's terminal host service`,
      );
    const kill = d.kill ?? ((pid, sig) => process.kill(pid, sig));
    const alive = d.alive ?? pidAlive;
    from = info.pid;
    ended = null;
    kill(info.pid, "SIGTERM");
    const deadline = Date.now() + (d.termWaitMs ?? 5000);
    while (alive(info.pid) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    if (alive(info.pid)) {
      kill(info.pid, "SIGKILL");
      const hard = Date.now() + 5000;
      while (alive(info.pid) && Date.now() < hard)
        await new Promise((r) => setTimeout(r, 50));
    }
    if (alive(info.pid))
      throw new Error(`the terminal host (pid ${info.pid}) didn't end`);
    // Its socket stays behind; a new host replaces a socket nobody answers.
  }
  return { from, forced: Boolean(stuck), ended, fromVersion };
}

/** stopAnyHost, then a new host (the service manager's, or on demand). */
export async function restartHost(d: RestartHostDeps): Promise<HostRestarted> {
  const stopped = await stopAnyHost(d);
  const back = await d.connect();
  const to = back.hostPid;
  back.close();
  return { ...stopped, to };
}
