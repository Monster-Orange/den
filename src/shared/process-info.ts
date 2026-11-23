/**
 * Issue 620: what Den reads of a process itself (never what it says about
 * itself): when it started, whose it is, its command name and its working
 * folder. Null when the process is gone or can't be read.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";

export interface ProcessInfo {
  /** Its start time, as `ps -o lstart=` prints it in UTC. */
  started: string;
  uid: number;
  /** Its command's name (ps comm), at most 80 characters. */
  command: string;
  /** Its working folder, when it can be read. */
  cwd?: string;
}

const PS = process.platform === "darwin" ? "/bin/ps" : "ps";
const LSOF = "/usr/sbin/lsof";
const ENV = { PATH: "/bin:/usr/bin:/usr/sbin", LC_ALL: "C", TZ: "UTC" };

function cwdOf(pid: number): string | undefined {
  try {
    if (process.platform === "linux")
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    const r = spawnSync(LSOF, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      env: ENV,
      timeout: 5_000,
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

export function processInfo(pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const r = spawnSync(
      PS,
      ["-o", "uid=", "-o", "lstart=", "-o", "comm=", "-p", String(pid)],
      { encoding: "utf-8", env: ENV, timeout: 5_000 },
    );
    if (r.status !== 0) return null;
    // uid, then lstart (five words in the C locale), then the command.
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/.exec(
      (r.stdout ?? "").split("\n")[0] ?? "",
    );
    if (!m) return null;
    const cwd = cwdOf(pid);
    return {
      uid: Number(m[1]),
      started: m[2].replace(/\s+/g, " "),
      command: m[3].split("/").pop()!.slice(0, 80),
      ...(cwd ? { cwd } : {}),
    };
  } catch {
    return null;
  }
}
