/**
 * Issue 144 GATE-SLOT: who may run a heavy test now.
 *
 * One machine runs gates for many repos and installs. Browser suites hold
 * the machine alone; cpu runs (unit suites) share up to `cpuSlots`, never
 * beside a browser run. First come, first served: a waiter never jumps the
 * one ahead of it, so a waiting browser run stops new cpu grants and can't
 * starve. Nothing is ever pre-empted: a later ask only waits, and a live
 * holder keeps its slot however long it runs (past its estimate it is
 * flagged, never stopped).
 *
 * Issue 462 backfill: while a browser run holds, up to `cpuBesideBrowser`
 * cpu runs may start beside it (within `cpuSlots`), even past a browser
 * waiter, if each is expected to end by the hold's expected end plus the
 * overrun margin, so the waiting browser run is not delayed; and never
 * while the machine's load per core is above `maxLoadPerCore`.
 *
 * Pure: the store (store.ts) reads the entries, takes back holders whose
 * processes are gone, then asks `grants` which waiters may start.
 */

export type GateKind = "browser" | "cpu";

export interface GateEntry {
  id: string;
  kind: GateKind;
  /** Who asked, in words: "<install> · <project> · <agent or person>". */
  who: string;
  /** What runs, a short label (never the command's arguments). */
  label: string;
  /** The process that holds or waits (gate run, or the agent's MCP server). */
  pid: number;
  /** The command gate run started: the slot stays while it still runs. */
  runPid?: number;
  /** When it asked (ISO); the queue's order. */
  askedAt: string;
  /** When it got the slot (ISO), or absent while waiting. */
  grantedAt?: string;
  /** When it was flagged past its estimate (ISO), once. */
  flaggedAt?: string;
  /** How long the run expects to take, minutes. */
  estimateMin: number;
  /** An agent asked (an agent token or DEN_AGENT), not a person. */
  agent?: boolean;
  /** Which agent (`agent:<id>`), when it said; its row on Agents shows it. */
  actor?: string;
  /** Issue 462: a cpu run granted beside a browser run's hold. */
  beside?: boolean;
}

export interface GateSettings {
  /** cpu runs that may share the machine (its load budget). */
  cpuSlots: number;
  /** Past its estimate by this much, a run is flagged (never stopped). */
  overrunMarginMinutes: number;
  /** cpu runs that may start beside one browser hold; 0: none (issue 462). */
  cpuBesideBrowser: number;
  /** No cpu run starts beside a browser hold above this 1-min load per core. */
  maxLoadPerCore: number;
}

export const GATE_DEFAULTS: GateSettings = {
  cpuSlots: 2,
  overrunMarginMinutes: 15,
  cpuBesideBrowser: 1,
  maxLoadPerCore: 2,
};

/** What `grants` needs from outside: the time, and the machine's load. */
export interface GateNow {
  now: number;
  /** os.loadavg()[0] / cpu count; the store reads it. */
  loadPerCore: number;
}

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** The queue's order: who asked first (id breaks a tie). */
export function byAsked(a: GateEntry, b: GateEntry): number {
  return t(a.askedAt) - t(b.askedAt) || a.id.localeCompare(b.id);
}

/** Which waiters may start now, in order. */
export function grants(
  entries: GateEntry[],
  s: GateSettings,
  at: GateNow = { now: Date.now(), loadPerCore: 0 },
): string[] {
  const holders = entries.filter((e) => e.grantedAt);
  const waiters = entries.filter((e) => !e.grantedAt).sort(byAsked);
  const out: string[] = [];
  const browser = holders.find((e) => e.kind === "browser");
  let cpuHeld = holders.filter((e) => e.kind === "cpu").length;
  const cpuMax = Math.max(1, s.cpuSlots);
  if (browser) {
    // Every cpu holder beside a browser hold started beside it: a browser
    // run never starts while a cpu run holds.
    const beside = Math.min(cpuMax, Math.max(0, s.cpuBesideBrowser));
    if (cpuHeld >= beside || at.loadPerCore > s.maxLoadPerCore) return out;
    const by = expectedEnd(browser) + s.overrunMarginMinutes * 60_000;
    let browserAhead = false;
    for (const w of waiters) {
      if (cpuHeld >= beside) break;
      if (w.kind === "browser") {
        browserAhead = true;
        continue;
      }
      if (browserAhead && at.now + w.estimateMin * 60_000 > by) continue;
      out.push(w.id);
      cpuHeld++;
    }
    return out;
  }
  for (const w of waiters) {
    if (w.kind === "browser") {
      if (cpuHeld > 0) break;
      // It starts now; who may start beside it is the backfill above.
      const started = new Date(at.now).toISOString();
      const next = entries.map((e) =>
        e.id === w.id ? { ...e, grantedAt: started } : e,
      );
      return [w.id, ...grants(next, s, at)];
    }
    if (cpuHeld >= cpuMax) break;
    out.push(w.id);
    cpuHeld++;
  }
  return out;
}

/**
 * Whether an entry's processes are all gone (its slot is free at once).
 * gate run's own command counts: a wrapper killed hard leaves its run, and
 * the run keeps the slot until it ends.
 */
export function gone(e: GateEntry, alive: (pid: number) => boolean): boolean {
  return !alive(e.pid) && (e.runPid === undefined || !alive(e.runPid));
}

/** When a holder is expected to end (ms), from its grant and estimate. */
export function expectedEnd(e: GateEntry): number {
  return t(e.grantedAt ?? e.askedAt) + e.estimateMin * 60_000;
}

/** Past its estimate plus the margin: flagged, never stopped. */
export function overrun(
  e: GateEntry,
  s: Pick<GateSettings, "overrunMarginMinutes">,
  now: number,
): boolean {
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
