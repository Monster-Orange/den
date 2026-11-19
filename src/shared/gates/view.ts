/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it. Issue 498: with the release slot and who
 * holds it.
 */
import { expectedEnd, expectedStart, overrun, type GateKind } from "./rules.js";
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
  return { settings, release, slots };
}
