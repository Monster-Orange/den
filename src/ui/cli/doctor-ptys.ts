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
import {
  HOST_RESTART_ACTION,
  HOST_RESTART_TITLE,
  readHostRefreshState,
} from "../../shared/sessions/host-refresh-state.js";
import { personTimeZone } from "../../shared/time-zone.js";
import { localDateTime } from "../../shared/local-time.js";

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

/** The running Den's: its terminal host, its config, this machine. */
export function defaultPtyDeps(stateDir: string): PtyDeps {
  return {
    open: async () => {
      const { connectHost } = await import("../../shared/sessions/client.js");
      const { sessionPaths } = await import("../../shared/sessions/paths.js");
      let c;
      try {
        c = await connectHost(sessionPaths(stateDir).socket);
      } catch {
        return null; // none runs
      }
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
  /** What the running host says (null: none runs). */
  host: () => Promise<
    | (import("../../shared/sessions/host-refresh.js").HostRuns & {
        pid?: number;
        startedAt?: string;
      })
    | null
  >;
  installed: () => import("../../shared/sessions/host-refresh.js").Installed;
  /**
   * Issue 731: Den's own refresh of the host (host-refresh-state.ts): null
   * or absent when none is known.
   */
  refresh?: () =>
    | import("../../shared/sessions/host-refresh-state.js").HostRefreshState
    | null;
  /** Issue 731: the person's chosen time zone (user.yml time_zone), if any. */
  zone?: () => string | undefined;
}

export function defaultHostModuleDeps(stateDir: string): HostModuleDeps {
  return {
    host: async () => {
      const { connectHost } = await import("../../shared/sessions/client.js");
      const { sessionPaths } = await import("../../shared/sessions/paths.js");
      const { hostRuns } =
        await import("../../shared/sessions/host-refresh.js");
      let c;
      try {
        c = await connectHost(sessionPaths(stateDir).socket);
      } catch {
        return null;
      }
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
    refresh: () => readHostRefreshState(stateDir),
    zone: () => personTimeZone(),
  };
}

export async function hostModuleLines(
  _cli: string,
  d: HostModuleDeps,
): Promise<{ lines: string[]; check: OnboardCheck; problem: boolean }> {
  const { hostCheck } = await import("../../shared/sessions/host-refresh.js");
  let h: Awaited<ReturnType<HostModuleDeps["host"]>> = null;
  try {
    h = await d.host();
  } catch {
    h = null;
  }
  // Issue 731: never `sessions host --stop` (it stops every agent): Den
  // restarts the host itself when agents are idle, or the held write does.
  let detail: string;
  let status: "ok" | "warn" | "fail" = "ok";
  let refresh: OnboardCheck["refresh"];
  let held: OnboardCheck["held"];
  if (!h)
    detail =
      "no terminal host runs (it starts with the first agent or terminal)";
  else {
    const need = hostCheck(h, d.installed());
    if (need) {
      const head = `restart needed: ${need.restart === "code" ? "host code changed" : "terminal module changed"} (${need.why}): new agents and terminals may fail to start`;
      let r: ReturnType<NonNullable<HostModuleDeps["refresh"]>> = null;
      try {
        r = d.refresh?.() ?? null;
      } catch {
        r = null;
      }
      if (r?.state === "waiting") {
        // The common case: right after an update, Den's own refresh waits
        // for agents mid-turn. Den is on it: nothing for a person to do.
        status = "warn";
        let zone: string | undefined;
        try {
          zone = d.zone?.();
        } catch {
          zone = undefined;
        }
        const min = Math.max(1, Math.ceil(r.waitSeconds / 60));
        // Issue 732: a job an agent started holds it, not a turn: said so.
        const jobs = r.jobs ?? [];
        const jobWait = jobs.length
          ? `; it waits for ${jobs.map((j) => `agent ${j.agent}: a background job it started is still running (${j.minutes} min)`).join("; ")}`
          : "";
        detail = `${head}; Den restarts it when agents are idle (waiting since ${localDateTime(r.startedAt, zone)}, at most ${min} min)${jobWait}`;
        refresh = {
          state: "waiting",
          since: r.startedAt,
          waitSeconds: r.waitSeconds,
          ...(jobs.length ? { jobs } : {}),
        };
      } else {
        status = "fail";
        held = { action: HOST_RESTART_ACTION, title: HOST_RESTART_TITLE };
        const failed =
          r?.state === "failed"
            ? `; Den's restart of it failed: ${r.why ?? "no reason recorded"}`
            : "";
        if (r?.state === "failed")
          refresh = {
            state: "failed",
            since: r.startedAt,
            waitSeconds: r.waitSeconds,
            ...(r.endedAt ? { endedAt: r.endedAt } : {}),
            ...(r.why ? { why: r.why } : {}),
          };
        detail = `${head}${failed}; fix: ask for "${HOST_RESTART_TITLE}" (the held write ${HOST_RESTART_ACTION}, one Allow): it waits for agents mid-turn, restarts the host and resumes them`;
      }
    } else
      detail = h.pty
        ? `current: the terminal host runs the installed code and terminal module (${h.pty.path})`
        : "current: the terminal host runs the installed code (no terminal module loaded yet)";
  }
  const fail = status === "fail";
  const mark = status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
  return {
    lines: [`  Host  ${mark}  ${detail}`],
    check: {
      id: "terminal_host_module",
      status,
      detail,
      ...(held
        ? {
            fix: `${HOST_RESTART_ACTION}: ${HOST_RESTART_TITLE} (a held write, one Allow)`,
            held,
          }
        : {}),
      ...(refresh ? { refresh } : {}),
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
