/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it.
 */
import { expectedEnd, expectedStart, overrun } from "./rules.js";
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
}

export function gateView(store: GateStore, now = Date.now()) {
  const all = store.list();
  const settings = store.settings();
  const slots: GateSlotView[] = all.map((e) => ({
    id: e.id,
    kind: e.kind,
    who: e.who,
    label: e.label,
    granted: !!e.grantedAt,
    agent: e.agent === true,
    ...(e.actor ? { actor: e.actor } : {}),
    ...(e.remote ? { runner: e.remote.runner } : {}),
    ...(e.grantedAt
      ? {
          grantedAt: e.grantedAt,
          expectedEnd: new Date(expectedEnd(e)).toISOString(),
          overrun: overrun(e, settings, now),
        }
      : {
          askedAt: e.askedAt,
          expectedStart: new Date(expectedStart(all, e.id, now)).toISOString(),
        }),
  }));
  return { settings, slots };
}
