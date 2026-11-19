/**
 * Issue 503: doctor's PTY row. How many PTY masters the terminal host
 * holds (its `ptys` request), and how many the machine has in use of its
 * limit (macOS: /dev/ttys* against kern.tty.ptmx_max, read only; Linux:
 * /proc/sys/kernel/pty/nr and max). ✗ above sessions.pty_warn_above, or
 * once the machine reaches sessions.pty_machine_warn_percent of its limit:
 * past it, no terminal opens anywhere on the machine. Nothing fails when
 * no terminal host runs or a count can't be read.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  DEFAULT_PTY_MACHINE_WARN_PERCENT,
  DEFAULT_PTY_WARN_ABOVE,
  readSessionsConfig,
} from "../../shared/den-config.js";
import type { OnboardCheck } from "./doctor-onboard.js";
import { engineVersion } from "../../shared/paths.js";
import { installedPtyModule } from "../../shared/sessions/pty.js";
import { hostCodeId } from "../../shared/sessions/host-code.js";
import { sessionPaths } from "../../shared/sessions/paths.js";
import {
  describeHost,
  hostStuck,
  readHostInfo,
  type HostInfo,
} from "../../shared/sessions/host-stuck.js";

export interface PtySettings {
  warnAbove: number;
  machineWarnPercent: number;
}

export interface PtyDeps {
  /** The terminal host's open PTY masters; null: none runs, or it can't tell. */
  open: () => Promise<number | null>;
  settings: () => PtySettings;
  /** The machine's PTYs in use and its limit; null where unknown. */
  machine: () => { inUse: number; max: number } | null;
}

/** The machine's PTYs in use and its limit (read only; never sysctl -w). */
export function machinePtys(
  platform: NodeJS.Platform = process.platform,
): { inUse: number; max: number } | null {
  try {
    if (platform === "linux") {
      const inUse = Number(
        fs.readFileSync("/proc/sys/kernel/pty/nr", "utf-8").trim(),
      );
      const max = Number(
        fs.readFileSync("/proc/sys/kernel/pty/max", "utf-8").trim(),
      );
      return Number.isFinite(inUse) && max > 0 ? { inUse, max } : null;
    }
    if (platform === "darwin") {
      const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.tty.ptmx_max"], {
        encoding: "utf-8",
        timeout: 2000,
      });
      const max = Number(String(r.stdout ?? "").trim());
      if (r.status !== 0 || !(max > 0)) return null;
      const inUse = fs
        .readdirSync("/dev")
        .filter((f) => /^ttys\d+$/.test(f)).length;
      return { inUse, max };
    }
  } catch {
    /* unknown */
  }
  return null;
}

/**
 * Issue 500: one doctor run waits for a host that doesn't answer once (its
 * PTY row and its Host row ask the same host): the first wait's failure is
 * kept for STUCK_KEEP_MS, by state dir.
 */
const stuckSeen = new Map<string, { e: Error; at: number }>();
const STUCK_KEEP_MS = 60_000;

/**
 * The running host on `stateDir`'s socket: null when none runs; throws
 * when it doesn't answer (HostError "timeout", within
 * Settings › Terminal host wait), or once that was seen this run.
 */
async function doctorConnect(
  stateDir: string,
  timeoutMs?: number,
): Promise<import("../../shared/sessions/client.js").HostClient | null> {
  const seen = stuckSeen.get(stateDir);
  if (seen && Date.now() - seen.at < STUCK_KEEP_MS) throw seen.e;
  stuckSeen.delete(stateDir);
  const { connectHost, noHost } =
    await import("../../shared/sessions/client.js");
  try {
    return await connectHost(
      sessionPaths(stateDir).socket,
      timeoutMs === undefined ? {} : { timeoutMs },
    );
  } catch (e) {
    if (noHost(e)) return null;
    if (hostStuck(e))
      stuckSeen.set(stateDir, { e: e as Error, at: Date.now() });
    throw e;
  }
}

/** The running Den's: its terminal host, its config, this machine. */
export function defaultPtyDeps(stateDir: string): PtyDeps {
  return {
    open: async () => {
      let c;
      try {
        c = await doctorConnect(stateDir);
      } catch {
        return null; // it doesn't answer: the Host row says so
      }
      if (!c) return null; // none runs
      try {
        return (await c.ptys())?.open ?? null;
      } finally {
        c.close();
      }
    },
    settings: () => {
      try {
        const s = readSessionsConfig();
        return {
          warnAbove: s.ptyWarnAbove,
          machineWarnPercent: s.ptyMachineWarnPercent,
        };
      } catch {
        return {
          warnAbove: DEFAULT_PTY_WARN_ABOVE,
          machineWarnPercent: DEFAULT_PTY_MACHINE_WARN_PERCENT,
        };
      }
    },
    machine: () => machinePtys(),
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function ptyLines(
  title: string,
  d: PtyDeps,
): Promise<{ lines: string[]; check: OnboardCheck; problem: boolean }> {
  const s = d.settings();
  let open: number | null = null;
  try {
    open = await d.open();
  } catch {
    open = null;
  }
  const m = d.machine();
  const parts: string[] = [];
  let fail = false;
  if (open === null)
    parts.push(
      "the terminal host's PTYs: not known (none runs, or it can't count them)",
    );
  else {
    const over = open > s.warnAbove;
    fail ||= over;
    parts.push(
      `the terminal host holds ${plural(open, "PTY")}` +
        (over
          ? `, above sessions.pty_warn_above (${s.warnAbove}): something keeps closed terminals' PTYs open`
          : ` (✗ above ${s.warnAbove}, sessions.pty_warn_above)`),
    );
  }
  if (m) {
    const near = m.inUse >= (m.max * s.machineWarnPercent) / 100;
    fail ||= near;
    parts.push(
      `the machine uses ${m.inUse} of ${m.max}` +
        (near
          ? `, at or above sessions.pty_machine_warn_percent (${s.machineWarnPercent}%): soon no terminal opens anywhere on it`
          : ""),
    );
  }
  const detail = parts.join("; ");
  const mark = fail ? "✗" : open === null && !m ? "⚠" : "✓";
  return {
    lines: ["", `${title} doctor: Terminals`, "", `  PTYs  ${mark}  ${detail}`],
    check: {
      id: "terminal_host_ptys",
      status: fail ? "fail" : mark === "⚠" ? "warn" : "ok",
      detail,
    },
    problem: fail,
  };
}

/**
 * Issue 563: doctor's row for the terminal host's version and native
 * module. The host says what it runs and which module it loaded (its
 * `hello`); ✗ when that isn't what is installed (an update it outlived),
 * the module it loaded is gone from disk, or it is too old to say. No
 * host running, or one that loaded no module yet, is fine. Issue 597:
 * "current", or "restart needed: host code changed" / "terminal module
 * changed"; another Den version with the same code is current.
 */
export interface HostModuleDeps {
  /**
   * What the running host says (null: none runs). Issue 500: throws when
   * it doesn't answer (HostError "timeout").
   */
  host: () => Promise<
    | (import("../../shared/sessions/host-refresh.js").HostRuns & {
        pid?: number;
        startedAt?: string;
      })
    | null
  >;
  installed: () => import("../../shared/sessions/host-refresh.js").Installed;
  /** Issue 500: what the host wrote to sessions.host.json (null: none). */
  info?: () => import("../../shared/sessions/host-stuck.js").HostInfo | null;
}

export function defaultHostModuleDeps(
  stateDir: string,
  /** Issue 500 (tests): how long it waits for the host; default the setting. */
  timeoutMs?: number,
): HostModuleDeps {
  return {
    host: async () => {
      const { hostRuns } =
        await import("../../shared/sessions/host-refresh.js");
      const c = await doctorConnect(stateDir, timeoutMs);
      if (!c) return null;
      try {
        return { ...hostRuns(c), pid: c.hostPid, startedAt: c.hostStartedAt };
      } finally {
        c.close();
      }
    },
    installed: () => ({
      den: engineVersion() ?? null,
      code: hostCodeId(),
      pty: installedPtyModule(),
    }),
    info: () => readHostInfo(sessionPaths(stateDir).info),
  };
}

export async function hostModuleLines(
  cli: string,
  d: HostModuleDeps,
): Promise<{ lines: string[]; check: OnboardCheck; problem: boolean }> {
  const { hostCheck } = await import("../../shared/sessions/host-refresh.js");
  let h: Awaited<ReturnType<HostModuleDeps["host"]>> = null;
  let noAnswer: string | null = null;
  try {
    h = await d.host();
  } catch (e) {
    h = null;
    noAnswer = e instanceof Error ? e.message : String(e);
  }
  const fix = `${cli} sessions host --stop`; // words-ok: the CLI command itself
  let detail: string;
  let fail = false;
  let info: HostInfo | null = null;
  if (noAnswer !== null) {
    // Issue 500: a host that doesn't answer starts no shell: say so, with
    // what it wrote as it began to serve (its pid, its version).
    fail = true;
    try {
      info = d.info?.() ?? null;
    } catch {
      info = null;
    }
    detail = `the terminal host doesn't answer: ${noAnswer} (${describeHost(info)}): no agent or terminal can start; restart it from Terminal, or: ${fix}`;
  } else if (!h)
    detail =
      "no terminal host runs (it starts with the first agent or terminal)";
  else {
    const need = hostCheck(h, d.installed());
    if (need) {
      fail = true;
      detail = `restart needed: ${need.restart === "code" ? "host code changed" : "terminal module changed"} (${need.why}): new agents and terminals may fail to start; restart the terminal host: ${fix}`;
    } else
      detail = h.pty
        ? `current: the terminal host runs the installed code and terminal module (${h.pty.path})`
        : "current: the terminal host runs the installed code (no terminal module loaded yet)";
  }
  return {
    lines: [`  Host  ${fail ? "✗" : "✓"}  ${detail}`],
    check: {
      id: "terminal_host_module",
      status: fail ? "fail" : "ok",
      detail,
      ...(fail ? { fix } : {}),
      // Issue 500: a host that doesn't answer, and what it wrote.
      ...(noAnswer !== null
        ? {
            stuck: true,
            host: {
              pid: info?.pid ?? null,
              startedAt: info?.startedAt ?? null,
              den: info?.den ?? null,
              code: info?.code ?? null,
              pty: null,
            },
          }
        : {}),
      // What the host says it runs, for a live check (no secret in it).
      ...(h
        ? {
            host: {
              pid: h.pid ?? null,
              startedAt: h.startedAt ?? null,
              den: h.den ?? null,
              code: h.code ?? null,
              pty: h.pty,
            },
          }
        : {}),
    },
    problem: fail,
  };
}
