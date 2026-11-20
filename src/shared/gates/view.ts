/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it.
 */
import { expectedEnd, expectedStart, overrun, priorityIds } from "./rules.js";
import type { GateStore } from "./store.js";

export interface GateSlotView {
  id: string;
  kind: "browser" | "cpu";
  who: string;
  label: string;
  granted: boolean;
  agent: boolean;
  actor?: string;
  /** Issue 621: a CI runner's slot (held by lease): the runner's name. */
  runner?: string;
  /** Issue 625: the test box it holds a slot on (absent: this machine). */
  box?: string;
  /** Issue 625: a waiter that may go to a box: "any", or the box's name. */
  where?: string;
  grantedAt?: string;
  expectedEnd?: string;
  overrun?: boolean;
  askedAt?: string;
  expectedStart?: string;
  /**
   * Issue 715: a release run a person waits on: why, and whether it holds
   * priority now (false: it waits behind another, or already started).
   */
  priority?: { reason: string; holds: boolean };
}

/**
 * Issue 625: a test box as the queue shows it: its slots, how many are
 * held, and what its last check found ("unchecked" before the first).
 * Never how Den reaches it.
 */
export interface GateBoxView {
  name: string;
  slots: number;
  held: number;
  state: "open" | "held" | "unreachable" | "unchecked";
  reason?: string;
  checkedAt?: string;
}

export function gateBoxesView(
  store: GateStore,
  slots: { box?: string; granted: boolean }[],
): GateBoxView[] {
  const states = store.boxStates();
  return store.boxes().map((b) => {
    const st = states[b.name];
    return {
      name: b.name,
      slots: b.browser_slots,
      held: slots.filter((s) => s.granted && s.box === b.name).length,
      state: st?.state ?? "unchecked",
      ...(st?.reason ? { reason: st.reason } : {}),
      ...(st?.at ? { checkedAt: st.at } : {}),
    };
  });
}

export function gateView(store: GateStore, now = Date.now()) {
  const all = store.list();
  const settings = store.settings();
  const pri = priorityIds(all, settings);
  const slots: GateSlotView[] = all.map((e) => ({
    id: e.id,
    kind: e.kind,
    who: e.who,
    label: e.label,
    granted: !!e.grantedAt,
    agent: e.agent === true,
    ...(e.actor ? { actor: e.actor } : {}),
    ...(e.remote ? { runner: e.remote.runner } : {}),
    ...(e.box ? { box: e.box } : {}),
    ...(!e.grantedAt && e.where ? { where: e.where } : {}),
    ...(e.priority
      ? { priority: { reason: e.priority.reason, holds: pri.has(e.id) } }
      : {}),
    ...(e.grantedAt
      ? {
          grantedAt: e.grantedAt,
          expectedEnd: new Date(expectedEnd(e)).toISOString(),
          overrun: overrun(e, settings, now),
        }
      : {
          askedAt: e.askedAt,
          expectedStart: new Date(
            expectedStart(all, e.id, now, settings),
          ).toISOString(),
        }),
  }));
  return { settings, slots, boxes: gateBoxesView(store, slots) };
}
