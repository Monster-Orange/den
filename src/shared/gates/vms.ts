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

/** Issue 1274 review: readVms without blocking (async execFile). */
export async function readVmsAsync(share: number): Promise<VmReading> {
  const { execFile } = await import("child_process");
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cmd, args, { encoding: "utf-8", timeout: 5_000 }, (err, out) =>
        err ? reject(err) : resolve(String(out)),
      ),
    );
  // The same reading as readVms, its commands run without blocking.
  const outs = new Map<string, string | Error>();
  const key = (cmd: string, args: string[]) => [cmd, ...args].join("\0");
  const wanted: [string, string[]][] = [
    ["/bin/sh", ["-c", "command -v orbctl"]],
    ["/bin/sh", ["-c", "command -v docker"]],
    ["orbctl", ["list", "-f", "json"]],
    [
      "docker",
      ["info", "--format", "{{.MemTotal}}\t{{.NCPU}}\t{{.OperatingSystem}}"],
    ],
  ];
  await Promise.all(
    wanted.map(async ([c, a]) => {
      try {
        outs.set(key(c, a), await run(c, a));
      } catch (e) {
        outs.set(key(c, a), e as Error);
      }
    }),
  );
  return readVms(share, {
    exec: (c, a) => {
      const v = outs.get(key(c, a));
      if (v === undefined || v instanceof Error) throw v ?? new Error("unread");
      return v;
    },
  });
}

let vmCache: { at: number; share: number; value: VmReading } | undefined;
let vmReading: { at: number } | undefined;

/** Tests: forget the last reading. */
export function resetVmCache(): void {
  vmCache = undefined;
  vmReading = undefined;
}

/**
 * Issue 1274 review: the last VM reading, never waiting (a request path
 * must not shell out). Stale (30 s) or none: a read starts in the
 * background, one at a time; a failed read leaves the last reading and is
 * tried again after 30 s. Null until the first read lands.
 */
export function peekVms(
  share: number,
  read: (share: number) => Promise<VmReading> = readVmsAsync,
  now = Date.now(),
): VmReading | null {
  const fresh = vmCache && vmCache.share === share && now - vmCache.at < 30_000;
  const busy = vmReading && now - vmReading.at < 30_000;
  if (!fresh && !busy) {
    const started = { at: now };
    vmReading = started;
    void read(share)
      .then((value) => {
        vmCache = { at: now, share, value };
      })
      .catch(() => undefined)
      .finally(() => {
        // A failed read waits out its 30 s before the next.
        if (vmReading === started && vmCache?.at === now) vmReading = undefined;
      });
  }
  return vmCache && vmCache.share === share ? vmCache.value : null;
}
