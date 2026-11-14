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
import { readUserConfig, type UserConfig } from "../den-config.js";
import {
  processGroupState,
  type GroupState,
  type RecordedProcessGroup,
} from "../process/process-group.js";
import { isDaemonVerifiablyDead, type DaemonRecord } from "./service-runner.js";

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
      const st = await groupState({ pgid: d.pgid, startedAt: d.pgidStartedAt });
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
}

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
    log: (line: string) => void;
  },
): Promise<RestoreResult> {
  const out: RestoreResult = { restored: [], failed: [], skipped: [] };
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
    try {
      for (const a of addrs)
        if (!forgotten.has(a)) {
          forgotten.add(a);
          deps.forget(a);
        }
      const code = await deps.exec(ws, addrs);
      if (code === 0) {
        out.restored.push(ws);
        deps.log(`Restored after the restart: ${ws}: ${addrs.join(", ")}`);
      } else {
        out.failed.push({ workspace: ws, why: `exit ${code}` });
        deps.log(
          `  ⚠ ${ws}: services not restored (exit ${code}): ${addrs.join(", ")}`,
        );
      }
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      out.failed.push({ workspace: ws, why });
      deps.log(`  ⚠ ${ws}: services not restored: ${why}`);
    }
  }
  return out;
}
