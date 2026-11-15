/**
 * 0.4.49 GATE-SLOT (den#144): who may run a heavy test now.
 *
 * One machine runs gates for many repos and installs. Browser suites hold
 * the machine alone; cpu runs (unit suites) share up to `cpuSlots`, never
 * beside a browser run. First come, first served: a waiter never jumps the
 * one ahead of it, so a waiting browser run stops new cpu grants and can't
 * starve. Nothing is ever pre-empted: a later ask only waits.
 *
 * Pure: the store (store.ts) reads the entries, takes back dead or quiet
 * holders, then asks `grants` which waiters may start.
 */

export type GateKind = "browser" | "cpu";

export interface GateEntry {
  id: string;
  kind: GateKind;
  /** Who asked, in words: "<install> · <project> · <agent or person>". */
  who: string;
  /** What runs, a short label (never the command's arguments). */
  label: string;
  /** The process that holds or waits; gone = released. */
  pid: number;
  /** When it asked (ISO); the queue's order. */
  askedAt: string;
  /** When it got the slot (ISO), or absent while waiting. */
  grantedAt?: string;
  /** The holder's last sign of life (ISO); quiet past the lease = taken back. */
  aliveAt: string;
  /** How long the run expects to take, minutes. */
  estimateMin: number;
  /** An agent asked (an agent token), not a person. */
  agent?: boolean;
  /** Which agent (`agent:<id>`), when it said; its row on the Agents page shows the slot. */
  actor?: string;
}

export interface GateSettings {
  /** cpu runs that may share the machine. */
  cpuSlots: number;
  /** A holder quiet this long is taken back. */
  leaseMinutes: number;
  /** Past its estimate by this much, a run is flagged (never stopped). */
  overrunMarginMinutes: number;
}

export const GATE_DEFAULTS: GateSettings = {
  cpuSlots: 2,
  leaseMinutes: 30,
  overrunMarginMinutes: 15,
};

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** The queue's order: who asked first (id breaks a tie). */
export function byAsked(a: GateEntry, b: GateEntry): number {
  return t(a.askedAt) - t(b.askedAt) || a.id.localeCompare(b.id);
}

/** Which waiters may start now, in order. */
export function grants(entries: GateEntry[], s: GateSettings): string[] {
  const holders = entries.filter((e) => e.grantedAt);
  const waiters = entries.filter((e) => !e.grantedAt).sort(byAsked);
  const out: string[] = [];
  let browserHeld = holders.some((e) => e.kind === "browser");
  let cpuHeld = holders.filter((e) => e.kind === "cpu").length;
  for (const w of waiters) {
    if (w.kind === "browser") {
      if (browserHeld || cpuHeld > 0) break;
      out.push(w.id);
      browserHeld = true;
      continue;
    }
    if (browserHeld || cpuHeld >= Math.max(1, s.cpuSlots)) break;
    out.push(w.id);
    cpuHeld++;
  }
  return out;
}

/** Why a holder is taken back, or null. */
export function takenBackWhy(
  e: GateEntry,
  s: GateSettings,
  now: number,
  alive: (pid: number) => boolean,
): "gone" | "quiet" | null {
  if (!alive(e.pid)) return "gone";
  if (e.grantedAt && now - t(e.aliveAt) > s.leaseMinutes * 60_000)
    return "quiet";
  return null;
}

/** When a holder is expected to end (ms), from its grant and estimate. */
export function expectedEnd(e: GateEntry): number {
  return t(e.grantedAt ?? e.askedAt) + e.estimateMin * 60_000;
}

/** Past its estimate plus the margin: flagged, never stopped. */
export function overrun(e: GateEntry, s: GateSettings, now: number): boolean {
  return (
    !!e.grantedAt && now > expectedEnd(e) + s.overrunMarginMinutes * 60_000
  );
}

/**
 * For a waiter: when it may expect to start (ms): the holders' latest
 * expected end, plus the estimates of the waiters ahead of it. A guess.
 */
export function expectedStart(
  entries: GateEntry[],
  id: string,
  now: number,
): number {
  const queue = entries.filter((e) => !e.grantedAt).sort(byAsked);
  const ahead = queue.slice(
    0,
    Math.max(
      0,
      queue.findIndex((e) => e.id === id),
    ),
  );
  let free = Math.max(
    now,
    ...entries.filter((e) => e.grantedAt).map(expectedEnd),
  );
  for (const w of ahead) free += w.estimateMin * 60_000;
  return free;
}
