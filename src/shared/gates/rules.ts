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
 * Issue 498: a `release` run (a release candidate's bed, proven by its
 * tag: release-proof.ts) has its own reserved capacity, `releaseSlots`. It
 * goes ahead of every ordinary waiter, never takes an ordinary slot, and
 * no ordinary run ever takes its. While one holds or waits, no new ordinary
 * run starts, so the bed runs on a quiet machine: it waits for the ordinary
 * holders to finish, up to `releaseQuietWaitMinutes`, then starts anyway
 * (the store records the load). It still stops no one.
 *
 * Pure: the store (store.ts) reads the entries, takes back holders whose
 * processes are gone, then asks `grants` which waiters may start.
 */

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
  /** Issue 498: a release run's proven candidate tag, and its commit. */
  tag?: string;
  commit?: string;
  /** Issue 585: runPid leads its own process group (gate run made it so). */
  runGroup?: boolean;
  /** Issue 585: cancelled while running; freed once its group is gone. */
  cancelled?: { by: string; at: string };
}

export interface GateSettings {
  /** cpu runs that may share the machine (its load budget). */
  cpuSlots: number;
  /** Past its estimate by this much, a run is flagged (never stopped). */
  overrunMarginMinutes: number;
  /** Issue 498: release runs that may hold at once (reserved for them). */
  releaseSlots: number;
  /** Issue 498: how long a release run waits for ordinary holders to end. */
  releaseQuietWaitMinutes: number;
  /** Issue 498: a candidate tag older than this is no proof. */
  releaseTagMaxAgeHours: number;
  /** Issue 585: a cancelled run's grace between TERM and KILL. */
  cancelGraceSeconds: number;
}

export const GATE_DEFAULTS: GateSettings = {
  cpuSlots: 2,
  overrunMarginMinutes: 15,
  releaseSlots: 1,
  releaseQuietWaitMinutes: 10,
  releaseTagMaxAgeHours: 168,
  cancelGraceSeconds: 60,
};

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** The queue's order: who asked first (id breaks a tie). */
export function byAsked(a: GateEntry, b: GateEntry): number {
  return t(a.askedAt) - t(b.askedAt) || a.id.localeCompare(b.id);
}

/** The waiters' order: release runs first, then by ask (issue 498). */
export function byQueue(a: GateEntry, b: GateEntry): number {
  return (
    Number(b.kind === "release") - Number(a.kind === "release") || byAsked(a, b)
  );
}

/** Which waiters may start now, in order. */
export function grants(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> &
    Partial<Pick<GateSettings, "releaseSlots" | "releaseQuietWaitMinutes">>,
  now: number = Date.now(),
): string[] {
  const holders = entries.filter((e) => e.grantedAt);
  const waiters = entries.filter((e) => !e.grantedAt).sort(byAsked);
  const out: string[] = [];
  // Issue 498: release runs first, in their own reserved capacity.
  const ordinaryHeld = holders.some((e) => e.kind !== "release");
  let releaseHeld = holders.filter((e) => e.kind === "release").length;
  const releaseCap = Math.max(1, s.releaseSlots ?? GATE_DEFAULTS.releaseSlots);
  const quietMs =
    (s.releaseQuietWaitMinutes ?? GATE_DEFAULTS.releaseQuietWaitMinutes) *
    60_000;
  for (const w of waiters.filter((e) => e.kind === "release")) {
    if (releaseHeld >= releaseCap) break;
    if (ordinaryHeld && now - t(w.askedAt) < quietMs) break;
    out.push(w.id);
    releaseHeld++;
  }
  // While a release run holds or waits, no new ordinary run starts.
  if (releaseHeld > 0 || waiters.some((e) => e.kind === "release")) return out;
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

/**
 * Whether an entry's processes are all gone (its slot is free at once).
 * gate run's own command counts: a wrapper killed hard leaves its run, and
 * the run keeps the slot until it ends. Issue 585: a run that leads its own
 * process group goes on while anything in the group does.
 */
export function gone(e: GateEntry, alive: (pid: number) => boolean): boolean {
  if (alive(e.pid)) return false;
  if (e.runPid === undefined) return true;
  return !alive(e.runPid) && !(e.runGroup === true && alive(-e.runPid));
}

/** Who cancels: a person, or an agent by its proven `agent:<id>`. */
export type Canceller = { person: true } | { agent: string };

/**
 * Issue 585: the slot's owner (the agent that asked, by its id) or a
 * person may cancel it; no one else.
 */
export function mayCancel(e: GateEntry, c: Canceller): boolean {
  if ("person" in c) return c.person === true;
  return !!c.agent && !!e.actor && e.actor === c.agent;
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
  const queue = entries.filter((e) => !e.grantedAt).sort(byQueue);
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
