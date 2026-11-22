/**
 * Issue 993: a gate slot held past `overrunBellMultiple` times its
 * estimate (default 2) is one line in the bell's Needs you: who holds it,
 * what it runs, since when, and the estimate, with End for the person (the
 * person-only POST /api/gate-slots/end, which records who).
 *
 * Built from the machine's slot store on each read, so the line leaves the
 * bell as soon as the slot ends, however it ends (released, taken back,
 * ended early).
 */
import {
  overrunBell,
  type GateEntry,
  type GateSettings,
} from "../../shared/gates/rules.js";

/** One overrun slot as GET /api/notifications' `waiting` lists it. */
export interface GateOverrunWaiting {
  kind: "gate_overrun";
  id: string;
  /** The slot's kind: browser or cpu. */
  slot: string;
  who: string;
  label: string;
  /** When it got the slot (ISO). */
  since: string;
  estimateMin: number;
  /** Minutes past its estimate, rounded. */
  overMin: number;
  /** The agent that holds it, when an agent does. */
  agent?: string;
}

/** The slots past the multiple, longest held first. */
export function gateOverrunWaiting(
  entries: readonly GateEntry[],
  s: Pick<GateSettings, "overrunBellMultiple">,
  now: number,
): GateOverrunWaiting[] {
  return entries
    .filter((e) => overrunBell(e, s, now))
    .sort((a, b) => Date.parse(a.grantedAt!) - Date.parse(b.grantedAt!))
    .map((e) => {
      const held = (now - Date.parse(e.grantedAt!)) / 60_000;
      const est = e.estimateMin * (e.boxTimeScale ?? 1);
      const agent = e.actor?.startsWith("agent:")
        ? e.actor.slice("agent:".length)
        : "";
      return {
        kind: "gate_overrun" as const,
        id: e.id,
        slot: e.kind,
        who: e.who,
        label: e.label,
        since: e.grantedAt!,
        estimateMin: e.estimateMin,
        overMin: Math.max(1, Math.round(held - est)),
        ...(agent ? { agent } : {}),
      };
    });
}
