/**
 * Issue 144 GATE-SLOT: who may run a heavy test now.
 *
 * One machine runs gates for many repos and installs. Browser suites take
 * one of `browserSlots` (issue 511), never beside a holding cpu run; cpu
 * runs (unit suites) share up to `cpuSlots`. First come, first served: a
 * waiter never jumps the
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
 * Issue 511: a browser grant also needs the load per core at or under
 * `maxLoadPerCore`, and more than `ptyHeadroom` PTYs free below the
 * system's limit; `waitReason` says which keeps a waiter waiting. The
 * `release` kind has a slot of its own, counted apart: it never takes an
 * ordinary slot, and an ordinary run can't take it (issue 498 builds on
 * this seam).
 *
 * Pure: the store (store.ts) reads the entries, takes back holders whose
 * processes are gone, then asks `grants` which waiters may start.
 */

/** `release` is the reserved release slot (issue 498): never an ordinary run. */
export type GateKind = "browser" | "cpu" | "release";

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
  /**
   * cpu runs that may start beside one browser hold; 0: none (issue 462).
   * Default 1 on 8 or more cores, else 0.
   */
  cpuBesideBrowser: number;
  /**
   * No browser run, and no cpu run beside one, starts above this 1-min load
   * per core.
   */
  maxLoadPerCore: number;
  /**
   * Browser runs that may hold at once (issue 511). Default 1 below 8
   * cores, else floor(cores / 8), at most 3.
   */
  browserSlots: number;
  /** A browser run starts only with more than this many PTYs free. */
  ptyHeadroom: number;
}

/**
 * The defaults on a machine with `cores` cpus. The one place they are set:
 * a cpu run beside a browser hold only on 8 or more cores (issue 462), and
 * one browser slot per 8 cores, at least 1 and at most 3 (issue 511).
 */
export function gateDefaults(cores: number): GateSettings {
  return {
    cpuSlots: 2,
    overrunMarginMinutes: 15,
    cpuBesideBrowser: cores >= 8 ? 1 : 0,
    maxLoadPerCore: 2,
    browserSlots: cores < 8 ? 1 : Math.min(3, Math.floor(cores / 8)),
    ptyHeadroom: 50,
  };
}

/** What `grants` needs from outside: the time, and the machine's load. */
export interface GateNow {
  now: number;
  /** os.loadavg()[0] / cpu count; the store reads it. */
  loadPerCore: number;
  /** The system's PTYs in use and its limit; absent when unknown. */
  ptys?: { used: number; max: number };
}

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** The queue's order: who asked first (id breaks a tie). */
export function byAsked(a: GateEntry, b: GateEntry): number {
  return t(a.askedAt) - t(b.askedAt) || a.id.localeCompare(b.id);
}

/** The machine has room for a browser run (issue 511), or why not. */
function machineBusy(s: GateSettings, at: GateNow): string | undefined {
  if (at.loadPerCore > s.maxLoadPerCore)
    return `the load is ${at.loadPerCore.toFixed(2)} per core, above ${s.maxLoadPerCore}`;
  const p = at.ptys;
  if (p && p.max - p.used <= s.ptyHeadroom)
    return `${p.used} of ${p.max} PTYs are in use; a browser run needs more than ${s.ptyHeadroom} free`;
  return undefined;
}

/**
 * One pass over the queue: who starts now, and for each who waits, why.
 * `grants` and `waitReason` both read it, so they never disagree.
 */
function decide(
  entries: GateEntry[],
  s: GateSettings,
  at: GateNow,
): { granted: string[]; why: Map<string, string> } {
  const granted: string[] = [];
  const why = new Map<string, string>();
  const holders = entries.filter((e) => e.grantedAt);
  const waiters = entries.filter((e) => !e.grantedAt).sort(byAsked);

  // The release slot, counted apart (issue 498's seam): one at a time.
  let releaseHeld = holders.some((e) => e.kind === "release");
  for (const w of waiters.filter((e) => e.kind === "release")) {
    if (releaseHeld) why.set(w.id, "the release slot is held");
    else {
      granted.push(w.id);
      releaseHeld = true;
    }
  }

  const browserEnds = holders
    .filter((e) => e.kind === "browser")
    .map(expectedEnd);
  let cpuHeld = holders.filter((e) => e.kind === "cpu").length;
  const cpuMax = Math.max(1, s.cpuSlots);
  const browserMax = Math.max(1, s.browserSlots);
  const beside = Math.min(cpuMax, Math.max(0, s.cpuBesideBrowser));
  const busy = machineBusy(s, at);
  const loadHigh = at.loadPerCore > s.maxLoadPerCore;
  let browserAhead = false;
  let cpuAhead = false; // a cpu run waits ahead: later browser runs wait too
  let blocked = false; // strict order: nothing more starts this pass
  for (const w of waiters) {
    if (w.kind === "release") continue;
    if (blocked) {
      why.set(w.id, "behind an earlier run");
      continue;
    }
    if (w.kind === "browser") {
      const reason =
        browserEnds.length >= browserMax
          ? `all ${browserMax} browser slots are held`
          : cpuHeld > 0
            ? "a cpu run holds"
            : cpuAhead
              ? "behind an earlier cpu run"
              : browserAhead
                ? "behind an earlier browser run"
                : busy;
      if (!reason) {
        granted.push(w.id);
        browserEnds.push(at.now + w.estimateMin * 60_000);
        continue;
      }
      why.set(w.id, reason);
      browserAhead = true;
      // With no browser run holding, the queue keeps its order: the cpu
      // runs behind it wait for it (it can't starve).
      if (browserEnds.length === 0) blocked = true;
      continue;
    }
    // A cpu run.
    if (browserEnds.length > 0) {
      // Issue 462: beside a browser hold. Every cpu holder now started
      // beside one: a browser run never starts while a cpu run holds.
      const by = Math.min(...browserEnds) + s.overrunMarginMinutes * 60_000;
      const reason =
        beside === 0
          ? "a browser run holds"
          : cpuHeld >= beside
            ? `${cpuHeld} cpu run${cpuHeld === 1 ? "" : "s"} already run${cpuHeld === 1 ? "s" : ""} beside a browser run`
            : loadHigh
              ? `the load is ${at.loadPerCore.toFixed(2)} per core, above ${s.maxLoadPerCore}`
              : browserAhead && at.now + w.estimateMin * 60_000 > by
                ? "it would end after the browser run waiting next could start"
                : undefined;
      if (reason) {
        why.set(w.id, reason);
        cpuAhead = true;
      } else {
        granted.push(w.id);
        cpuHeld++;
      }
      continue;
    }
    if (cpuHeld >= cpuMax) {
      why.set(w.id, `all ${cpuMax} cpu slots are held`);
      blocked = true;
      continue;
    }
    granted.push(w.id);
    cpuHeld++;
  }
  return { granted, why };
}

/** Which waiters may start now, in order. */
export function grants(
  entries: GateEntry[],
  s: GateSettings,
  at: GateNow = { now: Date.now(), loadPerCore: 0 },
): string[] {
  return decide(entries, s, at).granted;
}

/** Why each waiter waits, in words, by id (those that may start: none). */
export function waitReasons(
  entries: GateEntry[],
  s: GateSettings,
  at: GateNow,
): Map<string, string> {
  return decide(entries, s, at).why;
}

/** Why a waiter waits, in words; undefined if it may start now. */
export function waitReason(
  entries: GateEntry[],
  s: GateSettings,
  at: GateNow,
  id: string,
): string | undefined {
  return decide(entries, s, at).why.get(id);
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
  const apart = (e: GateEntry) => e.kind === "release";
  const mine = entries.find((e) => e.id === id);
  const same = (e: GateEntry) => !mine || apart(e) === apart(mine);
  const queue = entries.filter((e) => !e.grantedAt && same(e)).sort(byAsked);
  const ahead = queue.slice(
    0,
    Math.max(
      0,
      queue.findIndex((e) => e.id === id),
    ),
  );
  let free = Math.max(
    now,
    ...entries.filter((e) => e.grantedAt && same(e)).map(expectedEnd),
  );
  for (const w of ahead) free += w.estimateMin * 60_000;
  return free;
}
