/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it, with who left the queue lately (issue 524).
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
  grantedAt?: string;
  expectedEnd?: string;
  overrun?: boolean;
  askedAt?: string;
  expectedStart?: string;
}

/** A run that left the queue before its grant (issue 524). */
export interface GateLeftView {
  id: string;
  kind: "browser" | "cpu";
  who: string;
  label: string;
  at: string;
  /** The signal that stopped it, or "asked". */
  signal: string;
  /** Minutes it waited. */
  minutes: number;
  /** Its place in the queue when it left (1 is next). */
  place: number;
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
  const left: GateLeftView[] = store.leftWaiting(now).map((r) => ({
    id: r.id,
    kind: r.kind,
    who: r.who,
    label: r.label,
    at: r.at,
    signal: r.signal ?? "asked",
    minutes: r.minutes ?? 0,
    place: r.place ?? 0,
  }));
  return { settings, slots, left };
}
