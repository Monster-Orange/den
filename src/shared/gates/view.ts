/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it.
 */
import { classOf, windowHeld } from "./classes.js";
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
  /** Issue 803: its class (from settings), when classes are set. */
  class?: string;
  /** Issue 803: held for its class's window ("22:00-06:00"). */
  window?: string;
}

export function gateView(store: GateStore, now = Date.now()) {
  const all = store.list();
  const settings = store.settings();
  const pri = priorityIds(all, settings);
  const held = windowHeld(all, settings.classes, now);
  const slots: GateSlotView[] = all.map((e) => ({
    id: e.id,
    kind: e.kind,
    who: e.who,
    label: e.label,
    granted: !!e.grantedAt,
    agent: e.agent === true,
    ...(e.actor ? { actor: e.actor } : {}),
    ...(e.remote ? { runner: e.remote.runner } : {}),
    ...(e.priority
      ? { priority: { reason: e.priority.reason, holds: pri.has(e.id) } }
      : {}),
    ...(settings.classes ? { class: classOf(e, settings.classes) } : {}),
    ...(held.has(e.id) ? { window: held.get(e.id)!.text } : {}),
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
  return { settings, slots };
}
