/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it. Issue 498: with the release slot and who
 * holds it.
 */
import {
  expectedEnd,
  expectedStart,
  minutesPast,
  overrun,
  type GateKind,
} from "./rules.js";
import type { GateStore } from "./store.js";

export interface GateSlotView {
  id: string;
  kind: GateKind;
  who: string;
  label: string;
  granted: boolean;
  agent: boolean;
  actor?: string;
  /** Issue 498: a release run's candidate tag. */
  tag?: string;
  /** Issue 585: cancelled, stopping its run before the slot frees. */
  cancelled?: boolean;
  /** Idle flag: its run's tree found idle past its estimate. */
  idle?: { since: string; minutesPast: number };
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
    ...(e.tag ? { tag: e.tag } : {}),
    ...(e.cancelled ? { cancelled: true } : {}),
    ...(e.idleAt
      ? { idle: { since: e.idleAt, minutesPast: minutesPast(e, now) } }
      : {}),
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
  const release = {
    slots: settings.releaseSlots,
    held: all
      .filter((e) => e.kind === "release" && e.grantedAt)
      .map((e) => ({ id: e.id, who: e.who, tag: e.tag ?? "" })),
  };
  // Group end: what outlived an ended run's group, while it lives.
  const survivors = store.livingSurvivors().map((r) => ({
    id: r.id,
    label: r.label,
    who: r.who,
    at: r.at,
    ...(r.actor ? { actor: r.actor } : {}),
    pids: r.survivors,
  }));
  return { settings, release, slots, survivors };
}
