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
 * Issue 715: a release run a person waits on (`gate run --priority
 * release --reason <why>`) goes to the front of its kind's queue. It never
 * passes a holder (nothing is pre-empted), nor a waiter that has waited
 * past `priorityPassLimitMinutes`. At most `priorityMax` such runs per kind
 * hold priority at a time (the first asked); a later one waits in line as
 * an ordinary run until the one ahead starts, then takes priority. The
 * store records each jump (who, why, what it passed).
 *
 * Issue 803: with classes set (classes.ts), a higher class's waiters go
 * first; within a class it is first-come, and a priority run never passes
 * a higher class. A windowed class's long run, outside its window, waits
 * (at the back, blocking no one) while a higher-class run holds or waits.
 * No classes: exactly the order above.
 *
 * Pure: the store (store.ts) reads the entries, takes back holders whose
 * processes are gone, then asks `grants` which waiters may start.
 */
import {
  classRank,
  windowHeld,
  windowOpens,
  type GateClasses,
} from "./classes.js";

export type GateKind = "browser" | "cpu";

export interface GateEntry {
  id: string;
  kind: GateKind;
  /** Who asked, in words: "<install> · <project> · <agent or person>". */
  who: string;
  /** Issue 803: the project it ran for (its class comes from settings). */
  project?: string;
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
  /**
   * Issue 621: a CI job in a runner VM asked over HTTP with a runner
   * token. It has no process here: it holds by lease, renewed every
   * remoteRenewSeconds, and is taken back once the lease lapses.
   */
  /**
   * Issue 715: a release run a person waits on asked for priority, with
   * why. `at`: when it took priority (the store records it once).
   */
  priority?: { for: "release"; reason: string; at?: string };
  remote?: {
    /** The runner token's name (who, in words). */
    runner: string;
    /** The runner token's id: only it renews or releases the slot. */
    tokenId: string;
    /** When the lease lapses (ISO). */
    leaseUntil: string;
  };
}

export interface GateSettings {
  /** cpu runs that may share the machine (its load budget). */
  cpuSlots: number;
  /** Past its estimate by this much, a run is flagged (never stopped). */
  overrunMarginMinutes: number;
  /** Issue 621: how often a runner renews its lease, seconds (it is told). */
  remoteRenewSeconds: number;
  /** Issue 621: a runner's lease not renewed this long is taken back. */
  remoteLapseSeconds: number;
  /** Issue 621: live slots (held or waiting) one runner token may have. */
  remoteMaxSlots: number;
  /** Issue 621: asks one runner token may have waiting on an answer. */
  remoteMaxAsks: number;
  /** Issue 715: marked release runs per kind that hold priority at once. */
  priorityMax: number;
  /** Issue 715: a waiter that has waited this long is never passed again. */
  priorityPassLimitMinutes: number;
  /** Issue 715: agents may ask for priority (else people only). */
  priorityAgents: boolean;
  /** Issue 803: the classes, read from the three lines; absent: off. */
  classes?: GateClasses;
  /** Issue 803: the lines as typed (absent when no classes are set). */
  classOrder?: string;
  classMap?: string;
  classWindows?: string;
}

export const GATE_DEFAULTS: GateSettings = {
  cpuSlots: 2,
  overrunMarginMinutes: 15,
  remoteRenewSeconds: 30,
  remoteLapseSeconds: 120,
  remoteMaxSlots: 4,
  remoteMaxAsks: 4,
  priorityMax: 1,
  priorityPassLimitMinutes: 60,
  priorityAgents: true,
};

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** The queue's order: who asked first (id breaks a tie). */
export function byAsked(a: GateEntry, b: GateEntry): number {
  return t(a.askedAt) - t(b.askedAt) || a.id.localeCompare(b.id);
}

type PrioritySettings = Pick<
  GateSettings,
  "priorityMax" | "priorityPassLimitMinutes" | "classes"
>;

/**
 * Issue 715: the marked waiters that hold priority now: per kind, the
 * first `priorityMax` that asked.
 */
export function priorityIds(
  entries: GateEntry[],
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
): Set<string> {
  const max = Math.max(
    0,
    Math.floor(s.priorityMax ?? GATE_DEFAULTS.priorityMax),
  );
  const out = new Set<string>();
  const n: Record<string, number> = {};
  for (const w of entries
    .filter((e) => !e.grantedAt && e.priority)
    .sort(byAsked)) {
    if ((n[w.kind] ?? 0) >= max) continue;
    n[w.kind] = (n[w.kind] ?? 0) + 1;
    out.add(w.id);
  }
  return out;
}

/**
 * The waiters in the order they start: by ask, except that a run holding
 * priority (issue 715) goes ahead of its kind's other waiters, never
 * ahead of one that has waited past the pass limit.
 */
export function queueOrder(
  entries: GateEntry[],
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
  now: number = Date.now(),
): GateEntry[] {
  const c = s.classes;
  const rank = (e: GateEntry) => classRank(e, c);
  const q = entries
    .filter((e) => !e.grantedAt)
    .sort((a, b) => rank(a) - rank(b) || byAsked(a, b));
  const pri = priorityIds(entries, s);
  if (!pri.size) return windowLast(q, entries, s, now);
  const limitMs =
    (s.priorityPassLimitMinutes ?? GATE_DEFAULTS.priorityPassLimitMinutes) *
    60_000;
  for (const p of q.filter((e) => pri.has(e.id))) {
    const from = q.indexOf(p);
    q.splice(from, 1);
    let to = from;
    for (let i = from - 1; i >= 0; i--) {
      const w = q[i]!;
      if (w.kind !== p.kind) continue;
      if (pri.has(w.id) || now - t(w.askedAt) > limitMs) break;
      if (rank(w) < rank(p)) break;
      to = i;
    }
    q.splice(to, 0, p);
  }
  return windowLast(q, entries, s, now);
}

/** Issue 803: the waiters a window holds back go last, in their order. */
function windowLast(
  q: GateEntry[],
  entries: GateEntry[],
  s: Partial<PrioritySettings>,
  now: number,
): GateEntry[] {
  const held = windowHeld(entries, s.classes, now);
  if (!held.size) return q;
  return [
    ...q.filter((e) => !held.has(e.id)),
    ...q.filter((e) => held.has(e.id)),
  ];
}

/** Issue 715: the same-kind waiters a priority run goes ahead of. */
export function passedBy(
  entries: GateEntry[],
  id: string,
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
  now: number = Date.now(),
): string[] {
  const p = entries.find((e) => e.id === id);
  if (!p || p.grantedAt) return [];
  const order = queueOrder(entries, s, now);
  const at = order.indexOf(p);
  return order
    .slice(at + 1)
    .filter((w) => w.kind === p.kind && byAsked(w, p) < 0)
    .map((w) => w.id);
}

/** Which waiters may start now, in order. */
export function grants(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> & Partial<PrioritySettings>,
  now: number = Date.now(),
): string[] {
  const holders = entries.filter((e) => e.grantedAt);
  const waiters = queueOrder(entries, s, now);
  const held = windowHeld(entries, s.classes, now);
  const out: string[] = [];
  let browserHeld = holders.some((e) => e.kind === "browser");
  let cpuHeld = holders.filter((e) => e.kind === "cpu").length;
  for (const w of waiters) {
    if (held.has(w.id)) continue; // issue 803: it waits for its window
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

/**
 * Whether an entry's processes are all gone (its slot is free at once).
 * gate run's own command counts: a wrapper killed hard leaves its run, and
 * the run keeps the slot until it ends.
 */
export function gone(e: GateEntry, alive: (pid: number) => boolean): boolean {
  if (e.remote) return false; // a lease holder: see lapsed
  return !alive(e.pid) && (e.runPid === undefined || !alive(e.runPid));
}

/** Issue 621: a runner's lease ran out (its slot is free at once). */
export function lapsed(e: GateEntry, now: number): boolean {
  return !!e.remote && !(Date.parse(e.remote.leaseUntil) > now);
}

/** 0 for a holder; a waiter's place in line (1 is next); -1 if absent. */
export function queuePlace(
  entries: GateEntry[],
  id: string,
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
  now: number = Date.now(),
): number {
  const e = entries.find((x) => x.id === id);
  if (!e) return -1;
  if (e.grantedAt) return 0;
  const queue = queueOrder(entries, s, now);
  return queue.findIndex((x) => x.id === id) + 1;
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
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
): number {
  const queue = queueOrder(entries, s, now);
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
  // Issue 803: held for its window: not before the window opens.
  const win = windowHeld(entries, s.classes, now).get(id);
  return win ? Math.max(free, windowOpens(win, now)) : free;
}
