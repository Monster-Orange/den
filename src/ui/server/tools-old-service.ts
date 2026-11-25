import type { AgentsResolved } from "../cli/agent-ops.js";
import {
  ToolsRestarts,
  type Held,
  type StaleOne,
  type ToolsOldWaiting,
} from "../../shared/agents/tools-restarts.js";
import type { RestartJob } from "../../shared/agents/restart-queue.js";

export const STALE_TTL_MS = 30_000;

interface Slot {
  t: ToolsRestarts;
  queue: { add(job: RestartJob): Promise<unknown> };
  stale: StaleOne[];
  at: number;
  asking: Promise<void> | null;
}
const slots = new Map<string, Slot>();

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
      restart: async () => undefined,
    });
    slots.set(stateDir, slot);
    s = slot;
  }
  return s;
}

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
  return s.t.start(list, o.restart);
}

export function holdToolsOld(stateDir: string, list: readonly Held[]): void {
  slotOf(stateDir).t.hold(list);
}

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

export function noteToolsOld(
  stateDir: string,
  list: readonly StaleOne[],
): void {
  const s = slotOf(stateDir);
  s.stale = list.map((a) => ({ id: a.id, workspace: a.workspace }));
  s.at = Date.now();
}

export function resetToolsOld(): void {
  slots.clear();
}
