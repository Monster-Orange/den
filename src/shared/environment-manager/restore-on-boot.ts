/**
 * 0.4.46 services.restore_on_boot: after the machine restarts, every
 * project's services that were up come back up, with no person.
 *
 * The record is Den's own registry of what runs (daemons.json): `up`
 * writes a service there and a person's `down` takes it off, while a
 * restart of the machine (or of Den under launchd) leaves it. So when the
 * web server starts, a service still on the record but no longer running
 * was up before and nobody stopped it. Those come back through the same
 * Up a person presses (its order, its dependencies, its secrets), one
 * project at a time. `autostart` plays no part: it only filters a
 * project-wide Up.
 *
 * Left alone: what still runs; a record whose checkout is gone or moved
 * (the startup prune says "stale" or "unresolved"); and a record Den can't
 * tell is down (no container it can check, no process group).
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import type { RestartQueue } from "../agents/restart-queue.js";
import { readUserConfig, type UserConfig } from "../den-config.js";
import {
  processGroupState,
  type GroupState,
  type RecordedProcessGroup,
} from "../process/process-group.js";
import {
  groupOf,
  isDaemonVerifiablyDead,
  type DaemonRecord,
} from "./service-runner.js";

/** Why the startup prune dropped a record (service-runner.ts). */
export type PrunedWhy = "unresolved" | "stale" | "dead";

/**
 * services.restore_wait_seconds: how long the restore waits for Docker at
 * boot (300, at least 0).
 */
export function servicesRestoreWaitSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  const v = read().services?.restore_wait_seconds;
  if (v === undefined || v === null) return 300;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  throw new Error(
    `services.restore_wait_seconds must be a number, at least 0 (user.yml; got ${JSON.stringify(v)})`,
  );
}

/** services.restore_on_boot in user.yml (true when unset). */
export function servicesRestoreOnBoot(
  read: () => UserConfig = readUserConfig,
): boolean {
  const v = read().services?.restore_on_boot;
  if (v === undefined || v === null) return true;
  if (typeof v === "boolean") return v;
  throw new Error(
    `services.restore_on_boot must be true or false (user.yml; got ${JSON.stringify(v)})`,
  );
}

/**
 * Of the records from before the startup prune, the services to bring
 * back, by project (in the record's order). `running` is the container
 * listing (null without Docker: nothing container-based is judged down).
 */
export async function servicesToRestore(
  before: readonly DaemonRecord[],
  opts: {
    pruned?: ReadonlyMap<string, PrunedWhy>;
    running: Set<string> | null;
    groupState?: (g: RecordedProcessGroup) => Promise<GroupState | null>;
  },
): Promise<Map<string, string[]>> {
  const groupState = opts.groupState ?? processGroupState;
  const plan = new Map<string, string[]>();
  for (const d of before) {
    const why = opts.pruned?.get(d.address);
    if (why === "stale" || why === "unresolved") continue;
    let down = isDaemonVerifiablyDead(d, opts.running);
    if (!down && typeof d.pgid === "number" && d.pgidStartedAt) {
      const st = await groupState(
        groupOf({ ...d, pgid: d.pgid, pgidStartedAt: d.pgidStartedAt }),
      );
      down = !!st && st.state !== "ours";
    }
    if (!down) continue;
    for (const ws of d.workspaces ?? []) {
      const list = plan.get(ws) ?? [];
      if (!list.includes(d.address)) list.push(d.address);
      plan.set(ws, list);
    }
  }
  return plan;
}

/**
 * Issue 1225: whether the restore waits for the container runtime first.
 * A record that lists containers needs it; so may a service recorded only
 * as a process group, whose own command starts containers (Den can't see
 * that from the record). So when this machine has a runtime (`runtime`:
 * detected, never assumed), the restore waits for it whatever the record
 * says. No runtime and no containers on the record: no wait.
 */
export function shouldWaitForContainers(
  records: readonly DaemonRecord[],
  o: { runtime: boolean },
): boolean {
  return o.runtime || records.some((d) => (d.containers?.length ?? 0) > 0);
}

/**
 * Issue 1225: whether a container runtime (`docker`) is on `pathVar`: the
 * restore waits for one only when this machine has one. Detected, never
 * assumed.
 */
export async function containerRuntimeOnPath(
  pathVar: string = process.env.PATH ?? "",
): Promise<boolean> {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    try {
      await fs.promises.access(path.join(dir, "docker"), fs.constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * Issue 1225: the container listing for the wait, null until the runtime
 * answers. The plain listing returns an empty set when the runtime doesn't
 * answer yet (at boot), which the wait took for "ready" and so never
 * waited.
 */
export function containerListingOnceReady(d: {
  /** The runtime's own listing; null when it doesn't answer. */
  dockerNames: () => Promise<string[] | null>;
  /** The listing the restore judges by, once the runtime answers. */
  bases: () => Promise<Set<string> | null>;
}): () => Promise<Set<string> | null> {
  return async () => {
    if ((await d.dockerNames()) === null) return null;
    return (await d.bases()) ?? new Set<string>();
  };
}

/**
 * Wait for Docker (the container listing) up to `seconds`: at boot it may
 * start after Den. Null when it never answered.
 */
export async function waitForContainers(
  seconds: number,
  list: () => Promise<Set<string> | null>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  everyMs = 5000,
): Promise<Set<string> | null> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const r = await list().catch(() => null);
    if (r || Date.now() >= until) return r;
    await sleep(everyMs);
  }
}

export interface RestoreResult {
  /** Projects whose services came back. */
  restored: string[];
  failed: { workspace: string; why: string }[];
  /** Projects no longer active: left down. */
  skipped: string[];
  /** Issue 1225: each service that came back and stayed up. */
  brought: string[];
  /** Issue 1225: each service that didn't, and why. */
  failedServices: { address: string; why: string }[];
}

/** The restore's level for a line: a failure is a warning (kept on disk). */
export type RestoreLogLevel = "lifecycle" | "warn";

export type HealthVerdict = "ok" | "error" | null;

/** Bring each project's services back, one project at a time. */
export async function restoreServicesOnBoot(
  plan: ReadonlyMap<string, string[]>,
  deps: {
    enabled: boolean;
    isActive: (workspace: string) => boolean;
    /**
     * Drop a record judged down, so Up doesn't take it for running (the
     * prune keeps what it can't check).
     */
    forget: (address: string) => void;
    /** Den's own Up for these services of the project; its exit code. */
    exec: (workspace: string, addresses: string[]) => Promise<number>;
    log: (line: string, level?: RestoreLogLevel) => void;
    /**
     * Issue 1225: of `addresses`, those down again once they've settled.
     * Without it, an Up that exits 0 counts as brought back (as before).
     */
    stillDown?: (workspace: string, addresses: string[]) => Promise<string[]>;
    health?: (workspace: string, address: string) => Promise<HealthVerdict>;
    /** Tries per project, the first included (default 3). */
    tries?: number;
    /** The wait before each check, and between tries (ms). */
    settleMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RestoreResult> {
  const out: RestoreResult = {
    restored: [],
    failed: [],
    skipped: [],
    brought: [],
    failedServices: [],
  };
  if (!deps.enabled || plan.size === 0) return out;
  const forgotten = new Set<string>();
  for (const [ws, addrs] of plan) {
    if (!deps.isActive(ws)) {
      out.skipped.push(ws);
      deps.log(
        `Not restored (project ${ws} is no longer active): ${addrs.join(", ")}`,
      );
      continue;
    }
    const tries = Math.max(1, deps.tries ?? 3);
    const sleep =
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const fail = (list: string[], why: string) => {
      if (list.length === 0) return;
      for (const a of list) out.failedServices.push({ address: a, why });
      deps.log(
        `  ⚠ ${ws}: not brought back (${why}): ${list.join(", ")}`,
        "warn",
      );
    };
    const verdicts = async (list: string[]) => {
      const v = new Map<string, HealthVerdict>();
      if (!deps.health) return v;
      const got = await Promise.all(
        list.map((a) => deps.health!(ws, a).catch(() => null)),
      );
      list.forEach((a, i) => v.set(a, got[i] ?? null));
      return v;
    };
    try {
      let todo = [...addrs];
      for (let t = 1; todo.length > 0; t++) {
        for (const a of todo)
          if (!forgotten.has(a)) {
            forgotten.add(a);
            deps.forget(a);
          }
        const code = await deps.exec(ws, todo);
        if (code !== 0) {
          out.failed.push({ workspace: ws, why: `exit ${code}` });
          fail(todo, `exit ${code}`);
          break;
        }
        let down: string[] = [];
        let checked = new Map<string, HealthVerdict>();
        if (deps.stillDown) {
          await sleep(deps.settleMs ?? 30_000);
          const [d, v] = await Promise.all([
            deps.stillDown(ws, todo),
            verdicts(todo),
          ]);
          checked = v;
          down = d.filter((a) => checked.get(a) !== "ok");
        }
        const up = todo.filter((a) => !down.includes(a));
        out.brought.push(...up);
        if (up.length)
          deps.log(`Restored after the restart: ${ws}: ${up.join(", ")}`);
        if (down.length === 0) {
          out.restored.push(ws);
          break;
        }
        if (t >= tries) {
          const why = `stopped again after it started (${tries} tries)`;
          const unhealthy = down.filter((a) => checked.get(a) === "error");
          out.failed.push({ workspace: ws, why });
          fail(
            down.filter((a) => !unhealthy.includes(a)),
            why,
          );
          fail(
            unhealthy,
            `its health check failed after it started (${tries} tries)`,
          );
          break;
        }
        deps.log(
          `${ws}: stopped again after it started, trying again (${t + 1} of ${tries}): ${down.join(", ")}`,
        );
        // The started ones are on the record again: forget only what died.
        for (const a of down) forgotten.delete(a);
        todo = down;
      }
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      out.failed.push({ workspace: ws, why });
      fail(addrs, why);
    }
  }
  return out;
}

/**
 * Issue 1225: the bell's line for a restore: how many came back, and each
 * one that didn't, with its reason. Null when there was nothing to do.
 */
export function restoreSummary(
  r: Pick<RestoreResult, "brought" | "failedServices">,
): { count: number; text: string } | null {
  const n = r.brought.length;
  if (n === 0 && r.failedServices.length === 0) return null;
  let text = `Brought back ${n} service${n === 1 ? "" : "s"} after the restart.`;
  if (r.failedServices.length)
    text += ` Not brought back: ${r.failedServices
      .map((f) => `${f.address} (${f.why})`)
      .join(", ")}.`;
  return { count: n, text };
}

/**
 * Issue 1225: of `addresses`, those down again: no record any more (the
 * startup reaper drops a service that died), or a record judged down as
 * the restore judges one (servicesToRestore).
 */
export async function stillDownOf(
  addresses: readonly string[],
  o: {
    records: readonly DaemonRecord[];
    running: Set<string> | null;
    groupState?: (g: RecordedProcessGroup) => Promise<GroupState | null>;
  },
): Promise<string[]> {
  const mine = o.records.filter((r) => addresses.includes(r.address));
  const plan = await servicesToRestore(mine, {
    running: o.running,
    groupState: o.groupState,
  });
  const judgedDown = new Set([...plan.values()].flat());
  // A record with no project still counts: servicesToRestore files by project.
  for (const r of mine)
    if (!(r.workspaces ?? []).length) {
      const p = await servicesToRestore([{ ...r, workspaces: ["-"] }], {
        running: o.running,
        groupState: o.groupState,
      });
      if (p.size) judgedDown.add(r.address);
    }
  return addresses.filter(
    (a) => !mine.some((r) => r.address === a) || judgedDown.has(a),
  );
}

/** Issue 1225: the last restore's result, for doctor. */
export const LAST_RESTORE_FILE = "services-restore.json";

export interface LastRestore {
  at: string;
  brought: string[];
  failedServices: { address: string; why: string }[];
}

export function writeLastRestore(
  stateDir: string,
  r: Pick<RestoreResult, "brought" | "failedServices">,
  now: Date = new Date(),
): void {
  const body: LastRestore = {
    at: now.toISOString(),
    brought: r.brought,
    failedServices: r.failedServices,
  };
  writeFileAtomic(
    path.join(stateDir, LAST_RESTORE_FILE),
    JSON.stringify(body) + "\n",
    { mode: 0o600 },
  );
}

export function readLastRestore(stateDir: string): LastRestore | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(stateDir, LAST_RESTORE_FILE), "utf8"),
    ) as Partial<LastRestore>;
    if (typeof v.at !== "string" || !Array.isArray(v.brought)) return null;
    return {
      at: v.at,
      brought: v.brought.filter((a): a is string => typeof a === "string"),
      failedServices: (Array.isArray(v.failedServices)
        ? v.failedServices
        : []
      ).filter(
        (f): f is { address: string; why: string } =>
          !!f && typeof f.address === "string" && typeof f.why === "string",
      ),
    };
  } catch {
    return null;
  }
}

/** Issue 1225: doctor's line for the restore; null when there's nothing to say. */
export function restoreDoctorLine(o: {
  enabled: boolean;
  last: LastRestore | null;
}): string | null {
  if (!o.enabled)
    return "services.restore_on_boot is off: services that were up stay down after a restart.";
  const s = o.last ? restoreSummary(o.last) : null;
  return s && o.last
    ? `Services after the last restart (${o.last.at}): ${s.text}`
    : null;
}

/**
 * Issue 1225: doctor's line when a recorded service lists containers but
 * this machine has no container runtime on PATH (`runtime`, detected by
 * containerRuntimeOnPath). A service recorded only as a process group may
 * need one too, but its record doesn't say, so only listed containers count.
 */
export function runtimeMissingDoctorLine(o: {
  runtime: boolean;
  records: readonly Pick<DaemonRecord, "address" | "containers">[];
}): string | null {
  if (o.runtime) return null;
  const need = o.records
    .filter((d) => (d.containers?.length ?? 0) > 0)
    .map((d) => d.address);
  if (need.length === 0) return null;
  const one = need.length === 1;
  return (
    `No container runtime (docker) on PATH, but ${need.length} ` +
    `${one ? "service needs" : "services need"} one: ${need.join(", ")}. ` +
    `A restart can't bring ${one ? "it" : "them"} back until one is installed.`
  );
}

/**
 * Issue 1225: a project's Up through the restart queue (issue 1129), so
 * services come back a few at a time and under its load ceiling, beside
 * the agents. One job per project: `service:<project>`.
 */
export function throughQueue(
  q: Pick<RestartQueue, "add">,
  exec: (workspace: string, addresses: string[]) => Promise<number>,
): (workspace: string, addresses: string[]) => Promise<number> {
  return async (ws, addrs) =>
    (await q.add({
      id: `service:${ws}`,
      why: "services",
      run: () => exec(ws, addrs),
    })) as number;
}
