/**
 * Issue 1274: what VMs on this machine have reserved. On 11-22 nine
 * container-runtime VMs, each given 32 GB and 12 cpus, promised more memory
 * than the 128 GB machine had; the gate couldn't see them, and the machine
 * was reset three times with its memory compressor full.
 *
 * Read from each runtime's own CLI: OrbStack's machines (`orbctl list -f
 * json`), and Docker's VM when it isn't OrbStack's (`docker info`). A
 * runtime that is installed but can't be read is "not counted", never 0.
 * Only names, memory and cpus are read: never a VM's environment.
 */
import { execFileSync } from "child_process";
import * as os from "os";

export interface VmReservation {
  runtime: "orbstack" | "docker";
  name: string;
  running: boolean;
  memBytes: number;
  cpus: number;
}

export interface VmReading {
  /** The machine's RAM. */
  ramBytes: number;
  /** vm_memory_share: warn over this share of RAM promised. */
  share: number;
  vms: VmReservation[];
  /** Runtimes installed here that couldn't be read. */
  notCounted: string[];
}

const MIB = 1024 ** 2;

/** OrbStack's machines from `orbctl list -f json`; null: not readable. */
export function orbReservations(json: string): VmReservation[] | null {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out: VmReservation[] = [];
  for (const m of list as Record<string, unknown>[]) {
    const c = (m?.config ?? {}) as Record<string, unknown>;
    const mib = Number(c.memory_limit_mib);
    const cpus = Number(c.cpu_limit);
    if (typeof m?.name !== "string" || !(mib > 0)) continue;
    out.push({
      runtime: "orbstack",
      name: m.name,
      running: m.state === "running",
      memBytes: mib * MIB,
      cpus: cpus > 0 ? cpus : 0,
    });
  }
  return out;
}

/** What running VMs promise against `share` × the machine's RAM. */
export function vmOvercommit(
  vms: readonly VmReservation[],
  ramBytes: number,
  share: number,
): { promised: number; limit: number; over: boolean } {
  const promised = vms
    .filter((v) => v.running)
    .reduce((n, v) => n + v.memBytes, 0);
  const limit = Math.round(ramBytes * share);
  return { promised, limit, over: promised > limit };
}

type Exec = (cmd: string, args: string[]) => string;

const realExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Whether a command is on PATH (an absent runtime is not "not counted"). */
function has(exec: Exec, cmd: string): boolean {
  try {
    exec("/bin/sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

/** Read every runtime here. Never throws. */
export function readVms(
  share: number,
  o: { exec?: Exec; ramBytes?: number } = {},
): VmReading {
  const exec = o.exec ?? realExec;
  const vms: VmReservation[] = [];
  const notCounted: string[] = [];
  let orb = false;
  if (has(exec, "orbctl")) {
    orb = true;
    let got: VmReservation[] | null = null;
    try {
      got = orbReservations(exec("orbctl", ["list", "-f", "json"]));
    } catch {
      got = null;
    }
    if (got) vms.push(...got);
    else notCounted.push("orbstack");
  }
  if (has(exec, "docker")) {
    try {
      const [mem, cpus, osName] = exec("docker", [
        "info",
        "--format",
        "{{.MemTotal}}\t{{.NCPU}}\t{{.OperatingSystem}}",
      ])
        .trim()
        .split("\t");
      // OrbStack's Docker shares the VM its machines run in: not twice.
      const isOrb = /orbstack/i.test(osName ?? "");
      if (!(orb && isOrb) && Number(mem) > 0 && process.platform !== "linux")
        vms.push({
          runtime: "docker",
          name: osName || "docker",
          running: true,
          memBytes: Number(mem),
          cpus: Number(cpus) || 0,
        });
    } catch {
      notCounted.push("docker");
    }
  }
  return { ramBytes: o.ramBytes ?? os.totalmem(), share, vms, notCounted };
}

let vmCache: { at: number; share: number; value: VmReading } | undefined;

/** readVms at most every 30 s (the Gate page asks every few seconds). */
export function cachedReadVms(share: number, now = Date.now()): VmReading {
  if (vmCache && vmCache.share === share && now - vmCache.at < 30_000)
    return vmCache.value;
  const value = readVms(share);
  vmCache = { at: now, share, value };
  return value;
}
