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
