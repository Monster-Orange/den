/**
 * Issue 585: withdrawing a gate slot (`<cli> gate cancel <id>`, POST
 * /api/gate-slots/cancel, the MCP tool gate_slot_cancel).
 *
 * The slot's owner or a person only (rules.ts mayCancel). A queued ask is
 * removed. A running `gate run` slot: TERM to its command's process group,
 * a grace (`cancel_grace_seconds`), then KILL; the slot is freed only when
 * the group is gone, so the next run never starts on top of a half-stopped
 * one. Only the group gate run made for that slot is ever signalled; a
 * slot with no run of its own (held over MCP) is freed without a signal.
 */
import { mayCancel, type Canceller, type GateEntry } from "./rules.js";
import type { GateCancel, GateStore } from "./store.js";

export interface StopDeps {
  /** Whether a pid is alive; a negative pid asks for a process group. */
  alive: (pid: number) => boolean;
  /** Sends a signal; a negative pid signals a process group. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function realStopDeps(store: GateStore): StopDeps {
  return {
    alive: (p) => store.isAlive(p),
    kill: (p, s) => process.kill(p, s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  };
}

const POLL_MS = 100;

/**
 * Stops a run: TERM, up to `graceMs` for it to end, then KILL and as long
 * again for it to go. `group`: the run leads its own process group, and
 * the whole group is signalled and waited for. Returns whether it is gone.
 */
export async function stopRun(
  runPid: number,
  group: boolean,
  graceMs: number,
  d: StopDeps,
): Promise<boolean> {
  const target = group ? -runPid : runPid;
  const up = () => d.alive(target);
  const send = (s: NodeJS.Signals) => {
    try {
      d.kill(target, s);
    } catch {
      /* already gone */
    }
  };
  const waitGone = async (ms: number) => {
    const until = d.now() + ms;
    while (up() && d.now() < until) await d.sleep(POLL_MS);
    return !up();
  };
  if (!up()) return true;
  send("SIGTERM");
  if (await waitGone(graceMs)) return true;
  send("SIGKILL");
  return waitGone(Math.max(graceMs, 1_000));
}

export type CancelResult =
  | { ok: false; code: "no_slot" | "not_yours" }
  | (GateCancel & {
      ok: true;
      /** Resolves when the slot is free (true), or its run stayed (false). */
      done: Promise<boolean>;
    });

/**
 * Cancels a slot for `canceller` (recorded as `by`): checks who, records
 * it, and stops a running slot's run before freeing it. The stop goes on
 * in `done`; a caller that answers at once (the web route) need not wait.
 */
export function cancelSlot(
  store: GateStore,
  id: string,
  canceller: Canceller,
  by: string,
  d: StopDeps = realStopDeps(store),
): CancelResult {
  const e: GateEntry | null = store.peek(id);
  if (!e) return { ok: false, code: "no_slot" };
  if (!mayCancel(e, canceller)) return { ok: false, code: "not_yours" };
  const c = store.cancel(id, by);
  if (!c) return { ok: false, code: "no_slot" };
  if (c.was === "running" && c.runPid !== undefined) {
    const runPid = c.runPid;
    const graceMs = store.settings().cancelGraceSeconds * 1000;
    const done = stopRun(runPid, c.group, graceMs, d).then((gone) => {
      if (gone) store.releaseCancelled(id);
      return gone;
    });
    return { ...c, ok: true, done };
  }
  return { ...c, ok: true, done: Promise.resolve(true) };
}

/** Idle flag: a release run cancels flagged slots (red-first stub). */
export function cancelIdleFor(
  _store: GateStore,
  _releaseId: string,
  _d?: StopDeps,
): { id: string; done: Promise<boolean> }[] {
  return [];
}
