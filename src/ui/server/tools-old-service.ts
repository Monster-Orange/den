/**
 * Issue 1223: the server's side of "N agents are on older tools". One
 * ToolsRestarts per state dir (the restart batch and its failures), and
 * the stale list it reads, cached: staleAgents asks the sessions host and
 * Hub, too slow for each bell read, so a read past STALE_TTL_MS asks again
 * in the background and the next read has it.
 */
import type { AgentsResolved } from "../cli/agent-ops.js";
import {
  ToolsRestarts,
  type Held,
  type StaleOne,
  type ToolsOldWaiting,
} from "../../shared/agents/tools-restarts.js";
import type { RestartJob } from "../../shared/agents/restart-queue.js";

/** How long a stale list is used before it's asked again. */
export const STALE_TTL_MS = 30_000;

interface Slot {
  t: ToolsRestarts;
  queue: { add(job: RestartJob): Promise<unknown> };
  stale: StaleOne[];
  at: number;
  asking: Promise<void> | null;
}
const slots = new Map<string, Slot>();

/** A queue that runs each job at once (no queue given: tests, the CLI). */
export const NO_QUEUE = { add: (j: RestartJob) => j.run() };

function slotOf(stateDir: string): Slot {
  let s = slots.get(stateDir);
  if (!s) {
    const slot: Slot = {
      t: null as unknown as ToolsRestarts,
      queue: NO_QUEUE,
      stale: [],
      at: 0,
      asking: null,
    };
    slot.t = new ToolsRestarts({
      queue: { add: (j) => slot.queue.add(j) },
      // Each call passes its own restart (start's second argument).
      restart: async () => undefined,
    });
    slots.set(stateDir, slot);
    s = slot;
  }
  return s;
}

/**
 * Restart N agents: sends `list` through `queue`, each by `restart`.
 * Returns the ones queued (an agent already under way isn't twice).
 */
export function restartToolsOld(
  stateDir: string,
  list: readonly StaleOne[],
  o: {
    queue?: { add(job: RestartJob): Promise<unknown> };
    restart: (a: StaleOne) => Promise<unknown>;
  },
): StaleOne[] {
  const s = slotOf(stateDir);
  s.queue = o.queue ?? NO_QUEUE;
  // Issue 1223 (PR review): each queued agent keeps this call's restart.
  return s.t.start(list, o.restart);
}

/** Issue 1407: the agents restart-stale held back, for the bell row. */
export function holdToolsOld(stateDir: string, list: readonly Held[]): void {
  slotOf(stateDir).t.hold(list);
}

/** The bell row now (the cached stale list), or null. */
export function toolsOldRow(
  d: Pick<AgentsResolved, "stateDir">,
  ask: () => Promise<StaleOne[]>,
  now: number = Date.now(),
): ToolsOldWaiting | null {
  const s = slotOf(d.stateDir());
  if (now - s.at >= STALE_TTL_MS && !s.asking) {
    s.asking = ask()
      .then((list) => {
        s.stale = list.map((a) => ({ id: a.id, workspace: a.workspace }));
        s.at = Date.now();
      })
      .catch(() => {
        s.at = Date.now();
      })
      .finally(() => {
        s.asking = null;
      });
  }
  return s.t.row(s.stale);
}

/** A fresh stale list (restart-stale just asked): the bell uses it now. */
export function noteToolsOld(
  stateDir: string,
  list: readonly StaleOne[],
): void {
  const s = slotOf(stateDir);
  s.stale = list.map((a) => ({ id: a.id, workspace: a.workspace }));
  s.at = Date.now();
}

/** Tests: forget every slot. */
export function resetToolsOld(): void {
  slots.clear();
}
